package dev.bandcodex.bt;

import android.bluetooth.*;
import android.util.Base64;
import org.json.JSONObject;
import java.io.*;
import java.util.UUID;
import java.util.concurrent.*;

/** Bytes for our own 128-bit UUID. Authentication/framing stays in the relay.
 * Factory UUIDs and explicit channel numbers are deliberately not accepted.
 */
public final class PrivateBluetoothPipe {
    static synchronized void emit(JSONObject value) {
        System.out.println(value.toString()); System.out.flush();
    }
    static JSONObject event(String type) throws Exception {
        return new JSONObject().put("type", type);
    }
    public static void main(String[] args) throws Exception {
        if (args.length < 2 || args.length > 3 || args.length == 3 && !args[2].equals("--service"))
            throw new IllegalArgumentException("Expected bonded band address, private UUID, optional --service");
        UUID uuid=UUID.fromString(args[1]);
        if (!uuid.equals(UUID.fromString("4aac2058-2595-47b8-b8c7-229f6d3d98de")))
            throw new IllegalArgumentException("Expected this project's dedicated UUID");
        BluetoothDevice target=OwnedBandContext.target(args[0]);
        final BluetoothSocket socket=target.createRfcommSocketToServiceRecord(uuid);
        ScheduledExecutorService timer=Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t=new Thread(r,"private-bt-deadline");t.setDaemon(true);return t;
        });
        ScheduledFuture<?> connectionDeadline=timer.schedule(() -> {
            try { socket.close(); } catch(IOException ignored) {}
        },6,TimeUnit.SECONDS);
        try {
            socket.connect();connectionDeadline.cancel(false);
            if(args.length==2)timer.schedule(() -> {
                try { socket.close(); } catch(IOException ignored) {}
                System.exit(124);
            },180,TimeUnit.SECONDS);
            emit(event("ready").put("protocol",2).put("uuid",uuid.toString()).put("secureRfcomm",true));
            Thread reader=new Thread(() -> {
                try {
                    byte[] buffer=new byte[4096];InputStream input=socket.getInputStream();int n;
                    while((n=input.read(buffer))>=0)
                        if(n>0)emit(event("rx").put("base64",Base64.encodeToString(buffer,0,n,Base64.NO_WRAP)));
                    emit(event("eof"));
                } catch(Exception error) {
                    try { emit(event("error").put("errorClass",error.getClass().getSimpleName())); }
                    catch(Exception ignored) {}
                }
            },"private-bt-read");
            reader.setDaemon(true);reader.start();
            BufferedReader commands=new BufferedReader(new InputStreamReader(System.in,"UTF-8"));String line;
            while((line=commands.readLine())!=null) {
                if(line.length()>100000)throw new IllegalArgumentException("Excessive pipe message");
                JSONObject item=new JSONObject(line);String type=item.getString("type");
                if(type.equals("close"))break;
                if(!type.equals("tx"))throw new IllegalArgumentException("Unknown pipe message");
                byte[] bytes=Base64.decode(item.getString("base64"),Base64.NO_WRAP);
                if(bytes.length<1||bytes.length>65536)throw new IllegalArgumentException("Invalid write size");
                socket.getOutputStream().write(bytes);socket.getOutputStream().flush();
            }
        } catch(Exception error) {
            emit(event("error").put("errorClass",error.getClass().getSimpleName()));
        } finally {
            connectionDeadline.cancel(false);socket.close();timer.shutdownNow();emit(event("closed"));
        }
    }
}
