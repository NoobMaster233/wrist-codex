package dev.bandcodex.bt;

import android.Manifest;
import android.bluetooth.*;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Looper;
import android.os.Process;
import android.os.ParcelUuid;
import android.util.Base64;
import org.json.JSONObject;
import java.io.*;
import java.util.UUID;
import java.util.concurrent.*;

/** A bounded byte pipe for the authorized phone Shell; protocol stays in Node.
 * This does not scan, pair, bind, or change Bluetooth/system settings.
 */
public final class BluetoothPipe {
    static synchronized void emit(JSONObject item) {
        System.out.println(item.toString()); System.out.flush();
    }
    private static JSONObject event(String type) throws Exception {
        return new JSONObject().put("type", type);
    }
    private static final class Connected {
        final BluetoothSocket socket; final int attempts; final boolean secure;
        Connected(BluetoothSocket value, int count, boolean mode) { socket=value; attempts=count; secure=mode; }
    }
    private static boolean hasSppUuid(BluetoothDevice target) {
        ParcelUuid[] records=target.getUuids();
        if(records==null)return false;
        for(ParcelUuid record:records)
            if(record.getUuid().equals(UUID.fromString("00001101-0000-1000-8000-00805f9b34fb")))return true;
        return false;
    }
    private static Connected connect(BluetoothDevice target, ScheduledExecutorService timer, int channel) throws Exception {
        UUID uuid=UUID.fromString("00001101-0000-1000-8000-00805f9b34fb");
        // Same bounded insecure-then-secure sequence as the existing upstream
        // client. No pairing call and no protocol bytes before connect succeeds.
        for(int attempt=0;attempt<(channel==5?1:2);attempt++) {
            final BluetoothSocket candidate=channel==5
                    ? (BluetoothSocket)target.getClass().getMethod("createInsecureRfcommSocket",int.class).invoke(target,5)
                    : attempt==0
                    ? target.createInsecureRfcommSocketToServiceRecord(uuid)
                    : target.createRfcommSocketToServiceRecord(uuid);
            ScheduledFuture<?> timeout=timer.schedule(()->{
                try { candidate.close(); } catch(IOException ignored) {}
            },6,TimeUnit.SECONDS);
            try {
                candidate.connect();return new Connected(candidate,attempt+1,attempt==1);
            } catch(IOException error) {
                candidate.close();
                if(channel==5||attempt==1)throw error;
            } finally { timeout.cancel(false); }
            Thread.sleep(350);
        }
        throw new IOException("No SPP connection");
    }
    public static void main(String[] args) throws Exception {
        if (Process.myUid() != 2000) throw new SecurityException("Authorized local ADB shell required");
        if (args.length < 1 || args.length > 4 || !args[0].matches("(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}"))
            throw new IllegalArgumentException("Expected owned bonded band address");
        boolean ble=false,service=false;int channel=0;
        for(int i=1;i<args.length;i++) {
            if(args[i].equals("--ble")&&!ble)ble=true;
            else if(args[i].equals("--service")&&!service)service=true;
            else if(args[i].equals("--channel=5")&&channel==0)channel=5;
            else throw new IllegalArgumentException("Unsupported pipe mode");
        }
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
            throw new IllegalStateException("Bluetooth must already be enabled");
        BluetoothDevice target = null;
        for (BluetoothDevice device : adapter.getBondedDevices())
            if (args[0].equalsIgnoreCase(device.getAddress())) target = device;
        if (target == null) throw new SecurityException("Target not already bonded");
        if(ble) { BlePipe.run(context,target,!service);return; }
        // Match the existing upstream SPP path: request only this bonded
        // target's service records before RFCOMM. No discovery scan/pairing.
        boolean sdpRequested = target.fetchUuidsWithSdp();
        // Match upstream: use cached UUIDs immediately, wait only while absent.
        for(int i=0;sdpRequested&&!hasSppUuid(target)&&i<20;i++)Thread.sleep(100);
        ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "band-bt-deadline"); t.setDaemon(true); return t;
        });
        BluetoothSocket active=null;
        try {
            Connected result=connect(target,timer,channel);
            final BluetoothSocket socket=result.socket;active=socket;
            // Diagnostic lifetime bound. Production lifecycle is not claimed.
            if(!service)timer.schedule(() -> {
                try { socket.close(); } catch (IOException ignored) {}
                System.exit(124);
            },300,TimeUnit.SECONDS);
            emit(event("ready").put("protocol", 1).put("sdpRequested", sdpRequested)
                    .put("connectionAttempts",result.attempts).put("secureRfcomm",result.secure).put("rfcommChannel",channel));
            Thread reader = new Thread(() -> {
                try {
                    InputStream input = socket.getInputStream(); byte[] buffer = new byte[4096];
                    int count;
                    while ((count = input.read(buffer)) >= 0) {
                        if (count != 0) emit(event("rx").put("base64", Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP)));
                    }
                    emit(event("eof"));
                } catch (Exception error) {
                    try { emit(event("error").put("errorClass", error.getClass().getSimpleName())); }
                    catch (Exception ignored) {}
                }
            }, "band-bt-read");
            reader.setDaemon(true); reader.start();
            BufferedReader commands = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
            String line;
            while ((line = commands.readLine()) != null) {
                if (line.length() > 100000) throw new IllegalArgumentException("Excessive command");
                JSONObject item = new JSONObject(line); String type = item.getString("type");
                if (type.equals("close")) break;
                if (!type.equals("tx")) throw new IllegalArgumentException("Unsupported pipe command");
                byte[] data = Base64.decode(item.getString("base64"), Base64.NO_WRAP);
                if (data.length == 0 || data.length > 65536) throw new IllegalArgumentException("Invalid write size");
                socket.getOutputStream().write(data); socket.getOutputStream().flush();
            }
        } catch (Exception error) {
            emit(event("error").put("errorClass", error.getClass().getSimpleName()));
        } finally {
            if(active!=null)active.close(); timer.shutdownNow(); emit(event("closed"));
        }
    }
}
