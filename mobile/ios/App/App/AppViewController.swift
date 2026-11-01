import Capacitor

/// The bridge view controller, subclassed because that is where Capacitor lets an
/// app register a plugin that lives in the app target rather than in a package.
class AppViewController: CAPBridgeViewController {
    /// Registers the app's own plugins once the bridge exists.
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(WebAuthSessionPlugin())
    }
}
