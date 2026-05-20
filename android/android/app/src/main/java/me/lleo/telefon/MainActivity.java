package me.lleo.telefon;

import android.Manifest;
import android.os.Bundle;
import android.webkit.PermissionRequest;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Ask the OS for camera + mic up front; without the OS grant the
        // WebView cannot satisfy getUserMedia even if we grant the WebView
        // permission request below.
        ActivityCompat.requestPermissions(
            this,
            new String[] {
                Manifest.permission.CAMERA,
                Manifest.permission.RECORD_AUDIO,
                Manifest.permission.POST_NOTIFICATIONS
            },
            1
        );

        // Grant WebRTC permission requests coming from the page. We subclass
        // Capacitor's chrome client so its file-chooser / other behaviour is
        // preserved, only adding onPermissionRequest.
        final Bridge bridge = this.getBridge();
        bridge.getWebView().setWebChromeClient(new BridgeWebChromeClient(bridge) {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });
    }
}
