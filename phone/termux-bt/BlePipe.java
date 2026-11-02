package dev.bandcodex.bt;

import android.bluetooth.*;
import android.content.Context;
import android.util.Base64;
import org.json.JSONObject;
import java.io.*;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.*;

/** Existing bonded target only; no scan, pairing, adapter or global settings. */
final class BlePipe extends BluetoothGattCallback {
    private volatile BluetoothGatt gatt;
    private volatile boolean closing;
    private BluetoothGattCharacteristic tx,rx,probe;
    private final CompletableFuture<Boolean> connected=new CompletableFuture<>(),services=new CompletableFuture<>(),descriptor=new CompletableFuture<>(),probeRead=new CompletableFuture<>();
    private final CompletableFuture<Integer> mtu=new CompletableFuture<>();

    private static void event(String type,String key,Object value) {
        try { JSONObject item=new JSONObject().put("type",type);if(key!=null)item.put(key,value);BluetoothPipe.emit(item); }
        catch(Exception ignored) {}
    }
    private void own(BluetoothGatt value) { if(gatt==null)gatt=value; }
    @Override public void onConnectionStateChange(BluetoothGatt value,int status,int state) {
        own(value);if(value!=gatt)return;
        if(state==BluetoothProfile.STATE_CONNECTED)connected.complete(status==BluetoothGatt.GATT_SUCCESS);
        else if(state==BluetoothProfile.STATE_DISCONNECTED) {
            connected.complete(false);
            if(!closing)event("error","errorClass","GattDisconnectedStatus"+status);
        }
    }
    @Override public void onServicesDiscovered(BluetoothGatt value,int status) {
        if(value==gatt)services.complete(status==BluetoothGatt.GATT_SUCCESS);
    }
    @Override public void onMtuChanged(BluetoothGatt value,int length,int status) {
        if(value==gatt)mtu.complete(status==BluetoothGatt.GATT_SUCCESS?length:23);
    }
    @Override public void onDescriptorWrite(BluetoothGatt value,BluetoothGattDescriptor item,int status) {
        if(value==gatt)descriptor.complete(status==BluetoothGatt.GATT_SUCCESS);
    }
    @Override public void onCharacteristicRead(BluetoothGatt value,BluetoothGattCharacteristic item,int status) {
        if(value==gatt&&item==probe)probeRead.complete(status==BluetoothGatt.GATT_SUCCESS);
    }
    private void received(BluetoothGatt value,BluetoothGattCharacteristic item,byte[] bytes) {
        if(value!=gatt||rx==null||!item.getUuid().equals(rx.getUuid())||closing)return;
        if(bytes.length>0)event("rx","base64",Base64.encodeToString(bytes,Base64.NO_WRAP));
    }
    @Override public void onCharacteristicChanged(BluetoothGatt value,BluetoothGattCharacteristic item) {
        byte[] bytes=item.getValue();if(bytes!=null)received(value,item,bytes);
    }
    @Override public void onCharacteristicChanged(BluetoothGatt value,BluetoothGattCharacteristic item,byte[] bytes) {
        received(value,item,bytes);
    }
    private static boolean contains(UUID uuid,String fragment) { return uuid.toString().replace("-","").toLowerCase().contains(fragment); }
    private void resolve() throws IOException {
        // Pinned upstream BTSpp.extractBleCharacteristics: FE95 service;
        // 005e notifications, 005f writes, optional 0050 service probe.
        for(BluetoothGattService service:gatt.getServices()) {
            if(!contains(service.getUuid(),"fe95"))continue;
            for(BluetoothGattCharacteristic item:service.getCharacteristics()) {
                if(contains(item.getUuid(),"005e"))rx=item;
                else if(contains(item.getUuid(),"005f"))tx=item;
                else if(contains(item.getUuid(),"0050"))probe=item;
            }
        }
        if(rx==null||tx==null||(tx.getProperties()&BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE)==0)
            throw new IOException("Expected VSCP characteristics absent");
    }
    private void close() {
        closing=true;if(gatt!=null){gatt.disconnect();gatt.close();}
    }
    static void run(Context context,BluetoothDevice device,boolean bounded) throws Exception {
        BlePipe pipe=new BlePipe();
        ScheduledExecutorService timer=Executors.newSingleThreadScheduledExecutor(r->{Thread t=new Thread(r,"band-ble-deadline");t.setDaemon(true);return t;});
        if(bounded)timer.schedule(()->{pipe.close();System.exit(124);},300,TimeUnit.SECONDS);
        try {
            BluetoothGatt result=device.connectGatt(context,false,pipe,BluetoothDevice.TRANSPORT_LE);
            if(result==null)throw new IOException("No GATT client");pipe.own(result);
            if(!pipe.connected.get(15,TimeUnit.SECONDS))throw new IOException("GATT connect rejected");
            int mtu=23;
            if(pipe.gatt.requestMtu(247)) {
                try{mtu=pipe.mtu.get(4,TimeUnit.SECONDS);}catch(TimeoutException ignored){}
            }
            if(!pipe.gatt.discoverServices()||!pipe.services.get(10,TimeUnit.SECONDS))throw new IOException("GATT discovery failed");
            pipe.resolve();
            if(!pipe.gatt.setCharacteristicNotification(pipe.rx,true))throw new IOException("Notification enable failed");
            BluetoothGattDescriptor cccd=pipe.rx.getDescriptor(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"));
            if(cccd==null)throw new IOException("Notification descriptor absent");
            cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            if(!pipe.gatt.writeDescriptor(cccd)||!pipe.descriptor.get(5,TimeUnit.SECONDS))throw new IOException("CCCD write failed");
            if(pipe.probe!=null&&pipe.gatt.readCharacteristic(pipe.probe)) {
                try{pipe.probeRead.get(2,TimeUnit.SECONDS);}catch(TimeoutException ignored){}
            }
            int chunkSize=Math.min(247,Math.max(23,mtu))-3;
            BluetoothPipe.emit(new JSONObject().put("type","ready").put("protocol",1).put("transport","ble")
                    .put("connectionAttempts",1).put("mtu",mtu).put("chunkBytes",chunkSize));
            BufferedReader input=new BufferedReader(new InputStreamReader(System.in,"UTF-8"));String line;
            while((line=input.readLine())!=null) {
                if(line.length()>100000)throw new IOException("Excessive BLE command");
                JSONObject item=new JSONObject(line);String type=item.getString("type");if(type.equals("close"))break;
                if(!type.equals("tx"))throw new IOException("Unsupported BLE command");
                byte[] data=Base64.decode(item.getString("base64"),Base64.NO_WRAP);
                if(data.length==0||data.length>65536)throw new IOException("Invalid BLE write size");
                for(int offset=0;offset<data.length;offset+=chunkSize) {
                    pipe.tx.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
                    pipe.tx.setValue(Arrays.copyOfRange(data,offset,Math.min(data.length,offset+chunkSize)));
                    if(!pipe.gatt.writeCharacteristic(pipe.tx))throw new IOException("BLE write rejected");
                    Thread.sleep(12);
                }
            }
        } catch(Exception error) {event("error","errorClass",error.getClass().getSimpleName());}
        finally {pipe.close();timer.shutdownNow();event("closed",null,null);}
    }
}
