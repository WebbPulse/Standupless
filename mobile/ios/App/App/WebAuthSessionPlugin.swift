import AuthenticationServices
import Capacitor

/// Runs the browser sign-in in an `ASWebAuthenticationSession`, which shares
/// Safari's sign-ins and passkeys and hands the callback straight back, so a
/// finished sign-in does not depend on the scheme being routed through the system.
@objc(WebAuthSessionPlugin)
public class WebAuthSessionPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "WebAuthSessionPlugin"
    public let jsName = "WebAuthSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    /// The session on screen. The system stops one that nothing retains.
    private var session: ASWebAuthenticationSession?

    /// The page's call waiting on that session, answered exactly once.
    private var pendingCall: CAPPluginCall?

    /// Which session may answer that call, so a replaced one that reports its
    /// cancellation late cannot refuse the call of the one that replaced it.
    private var attempt = UUID()

    /// Opens the session and answers with the callback URL it returns. A session
    /// already open gives way, answering its call with no URL.
    @objc func start(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"),
              let url = URL(string: raw),
              let callbackScheme = call.getString("callbackScheme") else {
            call.reject("A sign-in needs a url and a callback scheme", "invalid")
            return
        }
        DispatchQueue.main.async {
            self.dismissSession()
            let attempt = UUID()
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackScheme
            ) { [weak self] callback, error in
                DispatchQueue.main.async {
                    self?.finish(attempt: attempt, callback: callback, error: error)
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            self.pendingCall = call
            self.attempt = attempt
            if !session.start() {
                self.finish(attempt: attempt, callback: nil, error: nil)
            }
        }
    }

    /// Closes the session because the callback arrived some other way, so the
    /// page's call is answered with no URL rather than refused as a cancellation.
    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.dismissSession()
            call.resolve()
        }
    }

    /// Answers the waiting call with no URL and takes the session off screen.
    private func dismissSession() {
        let open = session
        pendingCall?.resolve()
        pendingCall = nil
        session = nil
        open?.cancel()
    }

    /// Answers the waiting call from how its session ended, unless it was closed.
    private func finish(attempt: UUID, callback: URL?, error: Error?) {
        guard attempt == self.attempt, let call = pendingCall else { return }
        pendingCall = nil
        session = nil
        if let callback = callback {
            call.resolve(["url": callback.absoluteString])
        } else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
            call.reject("The sign-in was closed", "cancelled")
        } else {
            call.reject("The browser could not be opened", "failed")
        }
    }

    /// Presents the session over the window showing the web view.
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.webView?.window ?? ASPresentationAnchor()
    }
}
