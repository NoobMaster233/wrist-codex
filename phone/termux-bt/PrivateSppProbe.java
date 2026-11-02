package dev.bandcodex.bt;

import android.Manifest;
import android.bluetooth.*;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Looper;
import android.os.ParcelUuid;
import android.os.Process;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.security.SecureRandom;
import java.util.UUID;
import java.util.concurrent.*;

/** Finite experiment for a separately started bttool SPP server.
 * Only an already bonded target is used. No vendor authentication, pairing,
 * settings changes, installation, or production pipe replacement.
 * START_ACK/EOF prove a bidirectional exchange, not a byte-for-byte echo.
 */
public final class PrivateSppProbe {
    private static synchronized void emit(JSONObject value) {
        System.out.println(value.toString()); System.out.flush();
    }
    private static JSONObject event(String name) throws Exception {
        return new JSONObject().put("event", name).put("atMs", System.currentTimeMillis());
    }
    private static void expect(InputStream input, byte[] expected) throws Exception {
        for (byte b : expected) {
            int value = input.read();
            if (value < 0) throw new EOFException("Private service closed");
            if (value != (b & 255)) throw new IOException("Unexpected private service reply");
        }
    }
    public static void main(String[] args) throws Exception {
        if (Process.myUid() != 2000) throw new SecurityException("Authorized ADB shell required");
        if (args.length != 4 || !args[0].matches("(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}"))
            throw new IllegalArgumentException("Expected bonded address, UUID, inspect/probe, hold seconds");
        UUID uuid = UUID.fromString(args[1]);
        if (uuid.equals(UUID.fromString("00001101-0000-1000-8000-00805f9b34fb")))
            throw new IllegalArgumentException("Factory SPP UUID is forbidden in this probe");
        boolean inspect = args[2].equals("inspect");
        if (!inspect && !args[2].equals("probe")) throw new IllegalArgumentException("Unknown mode");
        int hold = Integer.parseInt(args[3]);
        if (hold < 0 || hold > 150) throw new IllegalArgumentException("Hold must be 0..150 seconds");
        Looper.prepareMainLooper();
        Class<?> activityThread = Class.forName("android.app.ActivityThread");
        Object thread = activityThread.getMethod("systemMain").invoke(null);
        Context system = (Context)activityThread.getMethod("getSystemContext").invoke(thread);
        Context context = system.createPackageContext("com.android.shell", 0);
        Class<?> managerClass = Class.forName("android.os.BluetoothServiceManager");
        Class.forName("android.bluetooth.BluetoothFrameworkInitializer")
                .getMethod("setBluetoothServiceManager", managerClass)
                .invoke(null, managerClass.getConstructor().newInstance());
        if (context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED)
            throw new SecurityException("Existing Bluetooth permission required");
        BluetoothAdapter adapter = ((BluetoothManager)context.getSystemService(Context.BLUETOOTH_SERVICE)).getAdapter();
        if (adapter == null || adapter.getState() != BluetoothAdapter.STATE_ON)
            throw new IllegalStateException("Bluetooth must already be on");
        BluetoothDevice target = null;
        for (BluetoothDevice device : adapter.getBondedDevices())
            if (args[0].equalsIgnoreCase(device.getAddress())) target = device;
        if (target == null) throw new SecurityException("Target must already be bonded");
        boolean requested = target.fetchUuidsWithSdp();
        // Allow a bounded fresh SDP result rather than accepting a cached match.
        Thread.sleep(2500);
        JSONArray records = new JSONArray(); boolean present = false;
        ParcelUuid[] cached = target.getUuids();
        if (cached != null) for (ParcelUuid item : cached) {
            records.put(item.toString()); if (item.getUuid().equals(uuid)) present = true;
        }
        emit(event("sdp").put("requested", requested).put("privateUuidPresent", present)
                .put("cachedUuids", records).put("freshResultConfirmed", false));
        if (inspect) return;
        ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "private-spp-deadline"); t.setDaemon(true); return t;
        });
        final BluetoothSocket socket = target.createRfcommSocketToServiceRecord(uuid);
        boolean passed = false; int rounds = 0; long connectedAt = 0;
        ScheduledFuture<?> deadline = timer.schedule(() -> {
            try { socket.close(); } catch (IOException ignored) {}
        }, 8, TimeUnit.SECONDS);
        try {
            socket.connect(); connectedAt = System.currentTimeMillis(); deadline.cancel(false);
            emit(event("connected").put("uuid", uuid.toString()));
            timer.schedule(() -> {
                try { socket.close(); } catch (IOException ignored) {}
            }, hold + 12, TimeUnit.SECONDS);
            InputStream input = socket.getInputStream(); OutputStream output = socket.getOutputStream();
            byte[] nonce = new byte[32]; SecureRandom random = new SecureRandom();
            do {
                deadline = timer.schedule(() -> {
                    try { socket.close(); } catch (IOException ignored) {}
                }, 4, TimeUnit.SECONDS);
                random.nextBytes(nonce);
                output.write("START:32;".getBytes("US-ASCII")); output.flush();
                expect(input, "START_ACK".getBytes("US-ASCII"));
                output.write(nonce); output.flush();
                expect(input, new byte[] {'E', 'O', 'F', 0});
                deadline.cancel(false); rounds++;
                emit(event("round").put("number", rounds).put("dataBytes", nonce.length)
                        .put("startAck", true).put("eofAck", true).put("byteExactEchoTested", false));
                long remaining = hold * 1000L - (System.currentTimeMillis() - connectedAt);
                if (remaining <= 0) break;
                Thread.sleep(Math.min(20000L, remaining));
            } while (true);
            passed = true;
        } catch (Exception error) {
            emit(event("error").put("errorClass", error.getClass().getSimpleName()));
        } finally {
            deadline.cancel(false); socket.close(); timer.shutdownNow();
            emit(event("closed").put("passed", passed).put("rounds", rounds)
                    .put("connectedMs", connectedAt == 0 ? 0 : System.currentTimeMillis() - connectedAt));
        }
        if (!passed) System.exit(2);
    }
}
