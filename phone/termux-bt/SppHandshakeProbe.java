package dev.bandcodex.bt;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Looper;
import android.os.Process;
import org.json.JSONObject;
import java.io.InputStream;
import java.util.UUID;
import java.util.concurrent.*;

/** One bounded connection to an already bonded owned band, then close.
 * No scan, pairing, adapter change, binding, auth, files, or installation.
 */
public final class SppHandshakeProbe {
    public static void main(String[] args) throws Exception {
        if (Process.myUid() != 2000) throw new SecurityException("Authorized local ADB shell required");
        if (args.length != 2 || !args[0].matches("(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}") ||
                !(args[1].equals("--connect-only") || args[1].equals("--l1-start")))
            throw new IllegalArgumentException("Expected bonded band address and explicit probe mode");
        Looper.prepareMainLooper();
        Class<?> activityThread = Class.forName("android.app.ActivityThread");
        Object thread = activityThread.getMethod("systemMain").invoke(null);
        Context system = (Context)activityThread.getMethod("getSystemContext").invoke(thread);
        Context context = system.createPackageContext("com.android.shell", 0);
        Class<?> initializer = Class.forName("android.bluetooth.BluetoothFrameworkInitializer");
        Class<?> serviceManager = Class.forName("android.os.BluetoothServiceManager");
        initializer.getMethod("setBluetoothServiceManager", serviceManager)
                .invoke(null, serviceManager.getConstructor().newInstance());
        if (context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED)
            throw new SecurityException("Existing Bluetooth connect permission required");
        BluetoothAdapter adapter = ((BluetoothManager)context.getSystemService(Context.BLUETOOTH_SERVICE)).getAdapter();
        if (adapter == null || adapter.getState() != BluetoothAdapter.STATE_ON)
            throw new IllegalStateException("Bluetooth must already be enabled");
        BluetoothDevice target = null;
        for (BluetoothDevice device : adapter.getBondedDevices())
            if (args[0].equalsIgnoreCase(device.getAddress())) target = device;
        if (target == null) throw new SecurityException("Target is not already bonded");
        JSONObject report = new JSONObject();
        report.put("connected", false); report.put("l1Started", false);
        report.put("connectionAttempts", 1); report.put("bindingInvoked", false);
        report.put("authenticationInvoked", false); report.put("settingsChanged", false);
        report.put("sentBytes", 0);
        final BluetoothSocket socket = target.createInsecureRfcommSocketToServiceRecord(
                UUID.fromString("00001101-0000-1000-8000-00805f9b34fb"));
        ExecutorService executor = Executors.newSingleThreadExecutor(r -> {
            Thread worker = new Thread(r, "band-spp-connect"); worker.setDaemon(true); return worker;
        });
        long start = System.nanoTime();
        try {
            Future<?> connection = executor.submit(() -> {
                try { socket.connect(); } catch (Exception error) { throw new RuntimeException(error); }
            });
            connection.get(8, TimeUnit.SECONDS);
            report.put("connected", socket.isConnected());
            if (args[1].equals("--l1-start")) {
                byte[] request = L1Handshake.start();
                socket.getOutputStream().write(request); socket.getOutputStream().flush();
                report.put("sentBytes", request.length);
                InputStream in = socket.getInputStream();
                L1Handshake.Decoder decoder = new L1Handshake.Decoder();
                byte[] buffer = new byte[1024]; int received = 0;
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(4);
                while (!decoder.started && System.nanoTime() < deadline) {
                    int available = in.available();
                    if (available == 0) { Thread.sleep(10); continue; }
                    int count = in.read(buffer, 0, Math.min(buffer.length, available));
                    if (count < 0) throw new IllegalStateException("SPP closed before L1 response");
                    received += count; decoder.append(buffer, count);
                }
                report.put("receivedBytes", received); report.put("validFrames", decoder.validFrames);
                report.put("l1Started", decoder.started);
            }
        } catch (Exception error) {
            // Exception messages may contain addresses; report only the class.
            report.put("errorClass", error.getClass().getSimpleName());
        } finally {
            socket.close(); executor.shutdownNow();
            report.put("socketClosed", true);
            report.put("elapsedMs", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start));
        }
        System.out.println(report.toString());
    }
}
