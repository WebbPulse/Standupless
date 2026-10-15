package dev.standupless.app;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;

/**
 * The Standupless activity. It hosts the Capacitor web view on the hosted app
 * and lets that web view use passkeys for the site, which Android allows only
 * for the origins the app's Digital Asset Links verify.
 */
public class MainActivity extends BridgeActivity {

    /** Builds the bridge, then turns on WebAuthn where the WebView offers it. */
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        enablePasskeys();
    }

    /** Lets the web view call WebAuthn as this app, on WebViews that support it. */
    private void enablePasskeys() {
        if (bridge == null || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            return;
        }
        WebView webView = bridge.getWebView();
        WebSettingsCompat.setWebAuthenticationSupport(
            webView.getSettings(),
            WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP
        );
    }
}
