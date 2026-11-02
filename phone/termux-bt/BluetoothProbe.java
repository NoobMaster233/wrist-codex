package dev.bandcodex.bt;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Looper;
import android.os.ParcelUuid;
import android.os.Process;
import org.json.JSONArray;
import org.json.JSONObject;

/** Read-only proof of the existing ADB shell Bluetooth permissions.
 * Does not scan, pair, connect, disconnect, or change adapter/settings state.
 */
public final class BluetoothProbe {
    public static void main(String[] args) throws Exception {
        if (args.length != 1 || !args[0].matches("(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}")) {
            throw new IllegalArgumentException("Expected the owned band's Bluetooth address");
        }
        if (Process.myUid() != 2000) throw new SecurityException("Run through the authorized local ADB shell");
        Looper.prepareMainLooper();
        Class<?> activityThread = Class.forName("android.app.ActivityThread");
        Object thread = activityThread.getMethod("systemMain").invoke(null);
        Context system = (Context) activityThread.getMethod("getSystemContext").invoke(thread);
        Context context = system.createPackageContext("com.android.shell", 0);
        // RuntimeInit normally installs this process-local framework service
        // lookup before Application creation. app_process has no Application.
        Class<?> initializer = Class.forName("android.bluetooth.BluetoothFrameworkInitializer");
        Class<?> serviceManager = Class.forName("android.os.BluetoothServiceManager");
        initializer.getMethod("setBluetoothServiceManager", serviceManager)
                .invoke(null, serviceManager.getConstructor().newInstance());
        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        JSONObject result = new JSONObject();
        result.put("managerPresent", manager != null);
        result.put("managerBinderPresent", Class.forName("android.os.ServiceManager")
                .getMethod("getService", String.class).invoke(null, "bluetooth_manager") != null);
        if (adapter == null) {
            adapter = BluetoothAdapter.getDefaultAdapter();
            result.put("defaultAdapterPresent", adapter != null);
        }
        if (adapter == null) {
            // app_process has no Application. Use the framework factory with
            // this already authorized shell context's attribution source.
            try {
                java.lang.reflect.Method factory = BluetoothAdapter.class.getDeclaredMethod(
                        "createAdapter", Context.class);
                factory.setAccessible(true);
                adapter = (BluetoothAdapter) factory.invoke(null, context);
                result.put("attributedAdapterPresent", adapter != null);
            } catch (ReflectiveOperationException error) {
                result.put("factoryError", error.getClass().getSimpleName());
                JSONArray factories = new JSONArray();
                for (java.lang.reflect.Method method : BluetoothAdapter.class.getDeclaredMethods()) {
                    if (java.lang.reflect.Modifier.isStatic(method.getModifiers()) &&
                            method.getReturnType() == BluetoothAdapter.class) factories.put(method.toString());
                }
                result.put("adapterFactories", factories);
            }
        }
        result.put("uid", Process.myUid());
        result.put("contextPackage", context.getPackageName());
        result.put("connectPermission", context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED);
        result.put("adapterPresent", adapter != null);
        result.put("targetBonded", false);
        if (adapter != null) {
            result.put("adapterState", adapter.getState());
            for (BluetoothDevice device : adapter.getBondedDevices()) {
                if (!args[0].equalsIgnoreCase(device.getAddress())) continue;
                result.put("targetBonded", true);
                result.put("targetType", device.getType());
                result.put("targetBondState", device.getBondState());
                JSONArray services = new JSONArray();
                ParcelUuid[] uuids = device.getUuids();
                if (uuids != null) for (ParcelUuid uuid : uuids) services.put(uuid.toString());
                result.put("cachedTargetServices", services);
            }
        }
        result.put("scanInvoked", false);
        result.put("connectionInvoked", false);
        result.put("settingsChanged", false);
        System.out.println(result.toString());
    }
}
