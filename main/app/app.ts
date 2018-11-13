import {
    app,
    globalShortcut,
    ipcMain,
    BrowserWindow,
    BrowserWindowConstructorOptions,
    Tray,
    Menu,
    MenuItemConstructorOptions,
    MenuItem,
    EventEmitter,
} from "electron"
import installExtension, { REACT_DEVELOPER_TOOLS, REDUX_DEVTOOLS } from "electron-devtools-installer"
import * as path from "path"
import Semaphore from "semaphore-async-await"
import MainWindow from "./mainWindow"
import { isDevMode, Debug } from "./util"
import * as JSONPackage from "../../../package.json"
import { LiPTT } from "../liptt"
import { PTTState } from "../liptt/state"
import { User, FavoriteItem, ArticleAbstract, ArticleHeader } from "../model"

export class App {

    private mainWindow: MainWindow
    private windowOptions: BrowserWindowConstructorOptions
    private readonly iconSrc = path.join(__dirname, "../../../resources/icons/256x256.png")
    private tray: Tray

    private client: LiPTT

    constructor() {
        this.mainWindow = null
        this.windowOptions = {
            title: JSONPackage.name,
            show: false,
            frame: false,
            zoomToPageWidth: false,
            backgroundColor: "#312450",
            icon: this.iconSrc,
            // 透明的時候將不能resize, 因為framework上的限制
            // transparent: true,
            // skipTaskbar: process.platform === "win32" ? true : false,
        }
    }

    public run() {

        // https://electronjs.org/docs/tutorial/security
        if (!isDevMode()) {
            // there is a bug issue
            process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true"
        }

        this.client = new LiPTT()

        app.setName(JSONPackage.name)
        app.on("ready", () => {
            this.newWindow()
        })
        app.on("activate", () => {
            // on OS X it's common to re-create a window in the app when the
            // dock icon is clicked and there are no other windows open.
            if (this.mainWindow === null) {
                this.newWindow()
            }
        })
        app.on("ready", () => {

            if (isDevMode()) {
                // 安裝 react 開發者工具
                installExtension(REACT_DEVELOPER_TOOLS, true)
                .then((name: string) => {
                    // Debug.log(`Added Extension:  ${name}`)
                })
                .catch((err: any) => {
                    // Debug.error("REACT_DEVELOPER_TOOLS ", err)
                })
                // 安裝 redux 開發者工具
                installExtension(REDUX_DEVTOOLS)
                .then((name: string) => {
                    // Debug.log(`Added Extension:  ${name}`)
                })
                .catch((err: any) => {
                    // Debug.error("REDUX_DEVTOOLS ", err)
                })
            }

            globalShortcut.register("Escape", () => {
                if (this.mainWindow.isFocused()) {
                    this.quit()
                }
            })
            if (process.env.NODE_ENV === "dev") {
                globalShortcut.register("f5", () => {
                    this.mainWindow.reload()
                })
                globalShortcut.register("CommandOrControl+R", () => {
                    this.mainWindow.reload()
                })
            }
            this.mainWindow.once("show", () => {
                this.addAPI()
                if (isDevMode()) {
                    Debug.warn("electron in development mode")
                    const o: NotificationOptions = {
                        body: "開發者模式",
                    }
                    this.mainWindow.webContents.send("/notification", o)
                }
            })
        })

        app.on("before-quit", () => {
            this.mainWindow.forceQuit = true
        })

        const menuTemplate: MenuItemConstructorOptions[] = [
            {
                label: "File", submenu: [
                    { label: "File" },
                    {
                        label: "Quit",
                        // accelerator: process.platform === "win32" ? "Ctrl+Q" : "Cmd+Q",
                        click: () => {
                            this.quit()
                        },
                    },
                ],
            },
        ]

        if (process.platform === "darwin") {
            menuTemplate.unshift({} as any)
        }

        menuTemplate.push({
            label: "View",
            submenu: [
                {
                    label: "Toggle FullScreen",
                    accelerator: (() => {
                        if (process.platform === "darwin") {
                            return "Ctrl+Command+F"
                        } else {
                            return "F11"
                        }
                    })(),
                    click: (_: MenuItem, focusedWindow: BrowserWindow) => {
                        if (focusedWindow) {
                            focusedWindow.setFullScreen(!focusedWindow.isFullScreen())
                        }
                    },
                },
                {
                    label: "Toggle Developer Tools",
                    accelerator: "F12",
                    click: (_menuitem: MenuItem, browserWindow: BrowserWindow, _: Electron.Event) => {
                        browserWindow.webContents.toggleDevTools()
                    },
                },
            ],
        })

        const mainMenu: Menu = Menu.buildFromTemplate(menuTemplate)
        Menu.setApplicationMenu(mainMenu)

        if (!isDevMode()) {
            this.mainWindow.setMenuBarVisibility(false)
        }
    }

    private async quit() {
        await this.client.logout()
        app.quit()
        this.mainWindow = null
    }

    private newWindow() {
        this.mainWindow = new MainWindow(this.windowOptions)
        Debug.window = this.mainWindow
        this.mainWindow.on("close", (event: Electron.Event) => {
            if (!this.mainWindow.forceQuit) {
                event.preventDefault()
                this.mainWindow.forceQuit = true
                this.quit()
            }
        })
        this.tray = new Tray(this.iconSrc)
        this.tray.on("click", () => {
            this.mainWindow.show()
        })
    }

    private addAPI() {
        const lock = new Semaphore(1)

        ipcMain.on("/logout", async (_: EventEmitter) => {
            await this.client.logout()
        })

        ipcMain.on("/login", async (_: EventEmitter, user: User) => {
            if (user.username) {
                const s = await this.client.login(user.username, user.password)
                if (s === PTTState.MainPage) {
                    this.mainWindow.webContents.send("/login", true)
                } else {
                    this.mainWindow.webContents.send("/login", false)
                }
            } else {
                this.mainWindow.webContents.send("/login", false)
            }
        })

        ipcMain.on("/favor", async (_: EventEmitter) => {
            await lock.wait()
            const data: FavoriteItem[] = await this.client.getFavorite()
            this.mainWindow.webContents.send("/favor", data)
            lock.signal()
        })

        /// 進入看板
        ipcMain.on("/board", async (_: EventEmitter, board: string) => {
            await lock.wait()
            const result = await this.client.enterBoard(board)
            this.mainWindow.webContents.send("/board", result)
            lock.signal()
        })

        /// 取得文章列表
        ipcMain.on("/board/get-more", async (_: EventEmitter) => {

            let result: ArticleAbstract[] = []
            await lock.wait()
            for (let i = 0; i < 3; i++) {
                const ans = await this.client.getMoreArticleAbstract()
                result = [...result, ...ans]
            }
            this.mainWindow.webContents.send("/board/get-more", result)
            lock.signal()
        })

        /// 取得文章資訊
        ipcMain.on("/board/article-header", async (_: EventEmitter, ab: ArticleAbstract) => {
            await lock.wait()
            if (this.client.getState() !== PTTState.Board) {
                this.mainWindow.webContents.send("/board/article-header", {})
                lock.signal()
                return
            }
            const info = await this.client.getArticleInfoWithAbs(ab)
            this.mainWindow.webContents.send("/board/article-header", info)
            lock.signal()
        })

        // 進入文章
        // ipcMain.on("/article", async (_: EventEmitter, ab: ArticleAbstract) => {
        //     await lock.wait()
        //     const result = await this.client.enterArticle(ab)
        //     lock.signal()
        //     this.mainWindow.webContents.send("/article", result)
        // })

        /// 進入文章，取得文章內容
        ipcMain.on("/article/get-more", async (_: EventEmitter, h: ArticleHeader) => {
            await lock.wait()
            const ans = await this.client.getMoreArticleContent(h)
            Debug.warn(ans)
            this.mainWindow.webContents.send("/article/get-more", ans)
            lock.signal()
        })

        ipcMain.on("/left", async (_: EventEmitter) => {
            await lock.wait()
            await this.client.left()
            this.mainWindow.webContents.send("/left")
            lock.signal()
        })

        ipcMain.on("/terminal-snapshot", async (_: EventEmitter) => {
            this.mainWindow.webContents.send("/terminal-snapshot", this.client.GetTerminalSnapshot())
        })
    }
}
