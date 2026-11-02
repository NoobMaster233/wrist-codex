package dev.bandcodex.bt;
import android.content.Context;
import android.os.Looper;
import android.os.Process;
import org.json.JSONObject;

/** Read-only comparison of this authorized Shell's existing framework contexts. */
public final class ContextInfo {
    public static void main(String[] args) throws Exception {
        if(Process.myUid()!=2000)throw new SecurityException("Existing Shell required");
        System.out.println("{\"step\":\"shell\",\"uid\":2000}");System.out.flush();
        Looper.prepareMainLooper();
        Class<?> type=Class.forName("android.app.ActivityThread");
        Object thread=type.getMethod("systemMain").invoke(null);
        Context system=(Context)type.getMethod("getSystemContext").invoke(thread);
        for(Context context:new Context[]{system,system.createPackageContext("com.android.shell",0)}) {
            Class<?> source=Class.forName("android.content.AttributionSource");
            Object value=Context.class.getMethod("getAttributionSource").invoke(context);
            System.out.println(new JSONObject().put("context",context.getPackageName())
                .put("attributionUid",source.getMethod("getUid").invoke(value))
                .put("attributionPackage",source.getMethod("getPackageName").invoke(value)).toString());
        }
    }
}
