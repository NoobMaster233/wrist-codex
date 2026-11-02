package dev.bandcodex.bt;

import android.Manifest;
import android.bluetooth.*;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Looper;
import android.os.Process;

/** Use the existing authorized shell and bonding; never scan or pair. */
final class OwnedBandContext {
    static BluetoothDevice target(String address) throws Exception {
        if (Process.myUid() != 2000) throw new SecurityException("Authorized ADB shell required");
        if (!address.matches("(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}"))
            throw new IllegalArgumentException("Expected bonded band address");
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
        for (BluetoothDevice device : adapter.getBondedDevices())
            if (address.equalsIgnoreCase(device.getAddress())) return device;
        throw new SecurityException("Target must already be bonded");
    }
}
