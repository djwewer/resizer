// Resizer.app window: runs Contents/Resources/launch.sh (checks Python/ffmpeg, starts the local
// server) and shows the UI in a native WebKit window instead of a browser tab.
// Closing the window quits the app and stops the server. Build with macos/build.sh.

import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow?
    var web: WKWebView?
    var serverURL: URL?
    var serverPID: pid_t = 0
    var busy = false   // a render is queued or running (reported by the page)

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.global(qos: .userInitiated).async {
            let started = self.startServer()
            DispatchQueue.main.async {
                guard let (url, pid) = started else { NSApp.terminate(nil); return }
                self.serverURL = url
                self.serverPID = pid
                self.openWindow(url)
            }
        }
    }

    /// Runs launch.sh; it shows its own dialogs on failure. Returns the server URL and PID.
    func startServer() -> (URL, pid_t)? {
        guard let script = Bundle.main.path(forResource: "launch", ofType: "sh") else { return nil }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = [script]
        let pipe = Pipe()
        task.standardOutput = pipe
        do { try task.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        let line = String(decoding: data, as: UTF8.self)
            .split(separator: "\n").last.map(String.init) ?? ""
        let parts = line.split(separator: " ")
        guard task.terminationStatus == 0, parts.count == 2,
              let url = URL(string: String(parts[0])), let pid = Int32(parts[1]) else { return nil }
        return (url, pid)
    }

    func openWindow(_ url: URL) {
        let config = WKWebViewConfiguration()
        let content = config.userContentController
        content.addUserScript(WKUserScript(source: "window.RESIZER_NATIVE = true;",
                                           injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content.add(self, name: "busy")

        let web = WKWebView(frame: .zero, configuration: config)
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")   // no white flash before the dark page paints

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 900),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "Resizer"
        window.minSize = NSSize(width: 760, height: 560)
        window.backgroundColor = NSColor(red: 0.027, green: 0.027, blue: 0.051, alpha: 1)
        window.contentView = web
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("ResizerMain")
        window.makeKeyAndOrderFront(nil)

        web.load(URLRequest(url: url))
        self.web = web
        self.window = window
    }

    // MARK: - Page bridge

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "busy" { busy = (message.body as? Bool) ?? false }
    }

    /// <input type="file" multiple> in the page.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        guard let window = window else { completionHandler(nil); return }
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    // MARK: - Quitting

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // Closing the window quits the app; applicationShouldTerminate asks if a render is running.
        NSApp.terminate(nil)
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard busy else { return .terminateNow }
        let alert = NSAlert()
        alert.messageText = "Рендер ще триває"
        alert.informativeText = "Якщо вийти, рендер буде скасовано, а незавершені файли видалено."
        alert.addButton(withTitle: "Продовжити рендер")
        alert.addButton(withTitle: "Скасувати й вийти")
        if alert.runModal() == .alertFirstButtonReturn { return .terminateCancel }
        cancelAllRenders()
        return .terminateNow
    }

    /// Asks the server to stop ffmpeg and delete unfinished files (it answers once that is done).
    func cancelAllRenders() {
        guard let url = serverURL?.appendingPathComponent("api/cancel-all") else { return }
        var request = URLRequest(url: url, timeoutInterval: 8)
        request.httpMethod = "POST"
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in done.signal() }.resume()
        _ = done.wait(timeout: .now() + 8)
    }

    func applicationWillTerminate(_ notification: Notification) {
        if serverPID > 0 { kill(serverPID, SIGTERM) }
    }

    // MARK: - Menu (Edit is needed for Cmd+C/V/A in the name fields)

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Сховати Resizer", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Вийти з Resizer", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Редагувати")
        edit.addItem(withTitle: "Відмінити", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Повторити", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Вирізати", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Копіювати", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Вставити", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Вибрати все", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let windowItem = NSMenuItem()
        let win = NSMenu(title: "Вікно")
        win.addItem(withTitle: "Згорнути", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Закрити", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = win
        main.addItem(windowItem)

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
