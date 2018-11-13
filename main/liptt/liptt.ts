import { Client, Control, SocketState } from "../client"
import { FavoriteItem, FavoriteItemType, ArticleAbstract, ReadState, ArticleType, ArticleHeader } from "../model"
import { Terminal, Block } from "../model/terminal"
import { PTTState, StateFilter } from "./state"
import Semaphore from "semaphore-async-await"
import { Debug } from "../app"

export class LiPTT extends Client {

    /** "[]" "<>" "［］" "《》" */
    private readonly bracketReg = /[\u005b\u003c\uff3b\u300a]{1}[^\u005b\u003c\uff3b\u300a\u005d\u003e\uff3d\u300b]+[\u005d\u003e\uff3d\u300b]{1}/
    /** "()" */
    private readonly boundReg = /[\u0028]{1}[^\u0028\u0029]+[\u0029]{1}/
    private stat: PTTState
    private scst: SocketState
    private curIndex: number
    private board: string
    private curArticle: ArticleHeader
    private snapshot: Terminal

    constructor() {
        super()
        this.sub()
    }

    public GetTerminalSnapshot(): string {
        return this.snapshot.GetRenderString()
    }

    private sub() {
        this.on("Updated", this.onUpdated)
        this.on("StateUpdated", this.onStateUpdated)
        this.on("socket", this.onSocketChanged)
    }

    private onUpdated(term: Terminal) {
        const stat = StateFilter(term)
        this.snapshot = term.DeepCopy()
        if (stat === PTTState.WhereAmI) {
            return
        }
        this.emit("StateUpdated", term, stat)
    }

    private onStateUpdated(term: Terminal, stat: PTTState) {
        this.stat = stat
        if (this.stat === PTTState.MainPage) {
            this.curIndex = Number.MAX_SAFE_INTEGER
        }

        // Debug.log(StateString(this.stat))
        // for (let i = 0; i < 24; i++) {
        //     Debug.log(term.GetString(i))
        // }
    }

    private onSocketChanged(stat: SocketState) {
        this.scst = stat
        if (stat === SocketState.Connected) {
            Debug.warn("socket open")
        } else if (stat === SocketState.Closed) {
            Debug.warn("socket close")
        }
    }

    /** 建立連線, 然後登入 */
    public async login(user: string, pass: string): Promise<PTTState> {
        const stat = await this.connect()
        if (stat !== SocketState.Connected) {
            return new Promise<PTTState>((resolve) => {resolve(PTTState.None)})
        }

        while (this.stat !== PTTState.Username) {
            if (this.stat === PTTState.Overloading) {
                return PTTState.Overloading
            }
            await this.WaitForNext()
        }

        return this.Login(user, pass)
    }

    private async Login(user: string, pass: string): Promise<PTTState> {
        let [, stat] = await this.Send(user, 0x0D)

        if (stat !== PTTState.Password) {
            return stat
        }

        [, stat] = await this.Send(pass, 0x0D)

        if (stat !== PTTState.Accept) {
            return stat
        }

        while (true) {
            switch (stat) {
            case PTTState.Log:
                [, stat] = await this.Send(Control.Yes())
                continue
            case PTTState.AlreadyLogin:
                [, stat] = await this.Send(Control.Yes())
                continue
            case PTTState.AnyKey:
                [, stat] = await this.Send(Control.AnyKey())
                continue
            case PTTState.MainPage:
                return stat
            default:
            [, stat] = await this.WaitForNext()
            }
        }
    }

    public async logout(): Promise<void> {
        if (!this.isOpen) {
            return
        }
        let [, s] = await this.Send(Control.Left())
        while (s !== PTTState.MainPage) {
            [, s] = await this.Send(Control.Left())
        }
        this.send(Control.Goodbye())
        await this.WaitClose()
    }

    public async getFavorite(): Promise<FavoriteItem[]> {

        if (this.stat !== PTTState.MainPage) {
            let [, s] = await this.Send(Control.Left())
            while (s !== PTTState.MainPage) {
                [, s] = await this.Send(Control.Left())
            }
        }

        const items: FavoriteItem[] = []
        let ok = true

        let [term, stat] = await this.Send(Control.Favorite())

        while (stat === PTTState.Favorite && ok) {
            let i = 3
            const test = term.GetSubstring(3, 0, 2).trim()
            if (test !== "●" && test !== ">") {
                break
            }
            for (; i < 23; i++) {
                const indexStr = term.GetSubstring(i, 3, 7).trim()
                let index = Number.MAX_SAFE_INTEGER
                if (indexStr.length > 0) {
                    index = parseInt(indexStr, 10)
                    if (index <= items.length) {
                        continue
                    }
                } else {
                    ok = false
                    break
                }

                const typeStr = term.GetSubstring(i, 23, 27).trim()
                let itemType = FavoriteItemType.Board

                switch (typeStr) {
                case "目錄":
                    itemType = FavoriteItemType.Folder
                    break
                case "":
                    itemType = FavoriteItemType.Horizontal
                    break
                }
                if (itemType === FavoriteItemType.Horizontal) {
                    items.push({
                        key: index,
                        type: itemType,
                    })
                    continue
                }

                const name = term.GetSubstring(i, 10, 22).trim()
                const desc = term.GetSubstring(i, 30, 64).trim()
                if (itemType === FavoriteItemType.Folder) {
                    items.push({
                        key: index,
                        type: itemType,
                        name,
                        description: desc,
                    })
                    continue
                }

                const popuStr = term.GetSubstring(i, 64, 67)
                let popu: number = 0

                switch (popuStr) {
                case "HOT":
                    popu = 100
                    break
                case "爆!":
                    const block = term.GetBlock(i, 66)
                    switch (block.Foreground) {
                    case 37:
                        popu = 1000
                        break
                    case 31:
                        popu = 2000
                        break
                    case 34:
                        popu = 5000
                        break
                    case 36:
                        popu = 10000
                        break
                    case 32:
                        popu = 30000
                        break
                    case 33:
                        popu = 60000
                        break
                    case 35:
                        popu = 100000
                        break
                    }
                    break
                default:
                    popu = parseInt(popuStr, 10)
                    break
                }

                items.push({
                    key: index,
                    type: itemType,
                    name,
                    description: desc,
                    popularity: popu,
                })
            }

            if (ok) {
                [term, stat] = await this.Send(Control.PageDown())
            }
        }

        await this.Send(Control.Home())
        await this.Send(Control.Left())
        return items
    }

    public async enterBoard(board: string): Promise<boolean> {

        if (!/[0-9A-Za-z_\-]+/.test(board)) {
            return false
        }

        let t: Terminal
        let s: PTTState

        if (this.stat !== PTTState.MainPage) {
            [t, s] = await this.Send(Control.Left())
            while (s !== PTTState.MainPage) {
                [t, s] = await this.Send(Control.Left())
            }
        }

        [t, s] = await this.Send(Control.SearchBoard())
        if (s === PTTState.Search) {
            [t, s] = await this.Send(board, 0x0D)
        }
        if (s === PTTState.AnyKey) {
            while (s === PTTState.AnyKey) {
                [t, s] = await this.Send(Control.AnyKey())
            }
        } else if (s !== PTTState.Board) {
            return false
        }
        this.board = board
        this.curIndex = Number.MAX_SAFE_INTEGER
        let nStr = t.GetSubstring(3, 0, 7)
        if (nStr[0] === "●" || nStr[0] === ">") {
            nStr = nStr.slice(1)
        }
        nStr = nStr.trim()
        if (nStr !== "1") {
            [t, s] = await this.Send(0x30, 0x0D)
        }
        return true
    }

    public async getMoreArticleAbstract(): Promise<ArticleAbstract[]> {
        if (this.stat === PTTState.Article) {
            await this.Send(Control.Left())
        } else if (this.stat !== PTTState.Board) {
            return []
        }
        if (this.curIndex === Number.MAX_SAFE_INTEGER) {
            const [term] = await this.Send(Control.End())
            const ans = await this.getCurrentArticleAbstract(term)
            return ans
        } else if (this.curIndex > 0) {
            const [term] = await this.Send(this.curIndex.toString(10), 0x0D)
            const ans = await this.getCurrentArticleAbstract(term)
            return ans
        } else {
            return []
        }
    }

    public async getArticleInfoWithAbs(a: ArticleAbstract): Promise<ArticleHeader> {

        let h: ArticleHeader = {
            hasHeader: false,
            deleted: false,
        }

        const match = /^#[A-Za-z0-9_\-]{8}$/.exec(a.aid)
        if (!match) {
            h.deleted = true
            return h
        }

        const [t, s] = await this.Send(a.aid, 0x0D, 0x72)
        if (s === PTTState.Article) {
            if (t.GetString(3).startsWith("───────────────────────────────────────")) {
                h.hasHeader = true
            }
            if (h.hasHeader === true) {
                h.url = a.url
                h.coin = a.coin
                const group0 = /作者  ([A-Za-z0-9]+) \(([\S\s^\(^\)]*)\)\s*(?:看板  )?([A-Za-z0-9\-\_]+)?/.exec(t.GetString(0))
                if (group0) {
                    const g = group0.slice(1)
                    if (g[0]) {
                        h.author = g[0].toString()
                    }
                    if (g[1]) {
                        h.nickname = g[1].toString()
                    }
                    h.board = g[2] ? g[2].toString() : a.board
                }
                const group1 = /標題  (Re:|Fw:|)\s*(\[[^\[^\]]*\]|)\s*([\S\s]*)/.exec(t.GetString(1))
                if (group1) {
                    const g = group1.slice(1)
                    if (g[0]) {
                        if (g[0] === "Re:") {
                            h.type = ArticleType.回覆
                        } else if (g[0] === "Fw:") {
                            h.type = ArticleType.轉文
                        } else {
                            h.type = ArticleType.一般
                        }
                    }
                    if (g[1]) {
                        h.category = g[1].toString().slice(1, -1).trim()
                    }
                    if (g[2]) {
                        h.title = g[2].toString().trim()
                    }
                }
                const group2 = /時間  ([A-Z][a-z]+) ([A-Z][a-z]+)\s*(\d+)\s*(\d+:\d+:\d+)\s*(\d+)/.exec(t.GetString(2))
                if (group2) {
                    const g = group2.slice(1)
                    h.date = g.reduce((ans, cur) => ans + " " + cur)
                }
            }
            h = {...h, aid: a.aid, url: a.url, coin: a.coin}
        } else {
            h.deleted = true
        }
        await this.Send(Control.Left())
        return h
    }

    // public async enterArticle(a: ArticleAbstract): Promise<boolean> {
    //     const match = /^#[A-Za-z0-9_\-]{8}$/.exec(a.aid)
    //     if (!match) {
    //         return false
    //     }
    //     const [t, s] = await this.Send(a.aid, 0x0D, 0x72)
    //     if (s !== PTTState.Article) {
    //         return false
    //     }
    //     return true
    // }

    public async left(): Promise<void> {
        await this.Send(Control.Left())
    }

    public async getMoreArticleContent(h: ArticleHeader): Promise<Block[][]> {

        if (!h.aid || !h.board) {
            return []
        }

        if (!/^#[A-Za-z0-9_\-]{8}$/.test(h.aid)) {
            return []
        }

        if (!this.curArticle) {
            this.curArticle = {...h}
        }

        const lines: Block[][] = []
        let t: Terminal
        let s: PTTState
        let down = true

        while (this.stat !== PTTState.Article || h.aid !== this.curArticle.aid) {
            down = false
            if (this.stat === PTTState.Board) {
                [t, s] = await this.Send(h.aid, 0x0D, 0x72)
                if (s !== PTTState.Article) {
                    return []
                }
                this.curArticle = {...h}
                break
            } else if (this.stat === PTTState.Article) {
                if (h.aid !== this.curArticle.aid) {
                    await this.Send(Control.Left())
                    await this.Send(Control.Left())
                    const ok = await this.enterBoard(h.board)
                    if (!ok) {
                        return []
                    }
                }
            }
        }

        if (down) {
            [t, s] = await this.Send(Control.PageDown())
        }

        const regex = /瀏覽 第 ([\d\/]+) 頁 \(([\s\d]+)\%\)/

        const txt = t.GetString(23)

        const match = regex.exec(txt)
        if (match) {
            const result = match.slice(1)

            Debug.warn(result[0], result[1])
            return lines
        } else {
            return lines
        }
    }

    private async getCurrentArticleAbstract(term: Terminal): Promise<ArticleAbstract[]> {
        const result: ArticleAbstract[] = []
        for (let i = 22; i > 2; i--) {

            /// 文章編號
            let indexStr = term.GetSubstring(i, 0, 7).trim()
            let index: number = 0

            if (indexStr[0] === "●" || indexStr[0] === ">") {
                indexStr = indexStr[1] === " " ?
                    indexStr = indexStr.slice(2) :
                    (term.GetSubstring(i - 1, 1, 2) + indexStr.substr(1))
                indexStr = indexStr.trim()
            }

            if (indexStr === "★") {
                index = Number.MAX_SAFE_INTEGER
                // get AID
            } else if (indexStr !== "") {
                index = parseInt(indexStr, 10)
                if (!index) {
                    Debug.error(indexStr)
                }
                if (this.curIndex === Number.MAX_SAFE_INTEGER) {
                    this.curIndex = index
                } else if (index > this.curIndex) {
                    continue
                } else {
                    index = this.curIndex
                }
                this.curIndex--
            } else {
                break
            }

            /// 推/噓
            let like: number
            const echoStr = term.GetSubstring(i, 9, 11)
            switch (echoStr[0]) {
            case "爆":
                like = 100
                break
            case "X":
                like = echoStr[1] === "X" ? -100 : parseInt(echoStr[1], 10) * -10
                break
            default:
                like = parseInt(echoStr, 10)
                break
            }

            /// 文章狀態
            let state: ReadState
            switch (term.GetSubstring(i, 8, 9)) {
            case "+":
                state = ReadState.未讀
                break
            case "M":
                state = ReadState.已標記
                break
            case "S":
                state = ReadState.待處理
                break
            case "m":
                state = ReadState.已讀 | ReadState.已標記
                break
            case "s":
                state = ReadState.已讀 | ReadState.待處理
                break
            case "!":
                state = ReadState.鎖定
                break
            case "~":
                state = ReadState.新推文
                break
            case "=":
                state = ReadState.新推文 | ReadState.已標記
                break
            case " ":
                state = ReadState.已讀
                break
            default:
                state = ReadState.未定義
                break
            }

            /// 日期
            const dateStr = term.GetSubstring(i, 11, 16)

            /// 作者
            const author = term.GetSubstring(i, 17, 29).trim()
            let deleted: boolean = false
            if (author === "-") {
                deleted = true
            }

            /// 類型
            const typeStr = term.GetSubstring(i, 30, 32)
            let type: ArticleType
            switch (typeStr) {
            case "□":
                type = ArticleType.一般
                break
            case "R:":
                type = ArticleType.回覆
                break
            case "轉":
                type = ArticleType.轉文
                break
            default:
                type = ArticleType.未定義
                break
            }

            /// 標題
            let title: string = term.GetSubstring(i, 33, 80).trim()
            const match = this.bracketReg.exec(title)

            let item: ArticleAbstract = {
                key: index,
                date: dateStr,
                like,
                state,
                deleted,
                type,
                title,
                board: this.board,
            }

            if (!deleted && match) {
                const matchStr = match.toString()
                const category = matchStr.slice(1, -1)
                title = title.slice(matchStr.length).trim()
                item = { ...item, category, title }
            }

            if (!deleted) {
                const [aid, url, coin, t] = await this.getAID(i, term)
                term = t
                item = { ...item, aid, url }
                if (coin !== "") {
                    item = { ...item, coin: parseInt(coin, 10) }
                }
            }

            result.push(item)
        }

        return result
    }

    private rowOfCursor(term: Terminal): number {
        for (let i = 3; i < 23; i++) {
            const x = term.GetSubstring(i, 0, 2)
            if (x.startsWith(">") || x.startsWith("●")) {
                return i
            }
        }
        return -1
    }

    private async getAID(row: number, term: Terminal): Promise<[string, string, string, Terminal]> {
        const cursor = this.rowOfCursor(term)

        const command: number[] = []
        if (cursor !== row) {
            if (cursor > row) {
                for (let k = 0; k < (cursor - row); k++) {
                    command.push(0x1B, 0x5B, 0x41)
                }
            } else {
                for (let k = 0; k < (row - cursor); k++) {
                    command.push(0x1B, 0x5B, 0x42)
                }
            }
        }
        command.push(0x51)
        let [t] = await this.Send(Buffer.from(command))

        const [aid, url, coin] = this.getAIDetail(t);
        [t] = await this.Send(Control.AnyKey())

        return [aid, url, coin, t]
    }
    private getAIDetail(term: Terminal): [string, string, string] {
        let aid = ""
        let url = ""
        let coin = ""
        for (let i = 0; i < 20; i++) {
            const aidStr = term.GetString(i)
            if (aidStr.includes("文章代碼(AID)")) {
                aid = term.GetSubstring(i, 18, 27)
                const urlStr = term.GetString(i + 1)
                if (urlStr.includes("文章網址:")) {
                    url = term.GetSubstring(i + 1, 13, 75).trim()
                }
                const coinStr = term.GetString(i + 2)
                const reg = /\d+/
                const c = reg.exec(coinStr)
                if (c) {
                    coin = c.toString()
                }
                break
            }
        }
        return [aid, url, coin]
    }

    private WaitForNext(): Promise<[Terminal, PTTState]> {
        return new Promise((resolve) => {
            this.once("StateUpdated", (term: Terminal, stat: PTTState) => {
                resolve([term, stat])
            })
        })
    }

    private Send(data: Buffer | Uint8Array | string | number, ...optionalParams: any[]): Promise<[Terminal, PTTState]> {
        return new Promise((resolve) => {
            this.once("StateUpdated", (term: Terminal, stat: PTTState) => {
                resolve([term, stat])
            })
            this.send(data, optionalParams)
        })
    }

    private WaitClose(): Promise<void> {
        return new Promise((resolve) => {
            if (this.scst === SocketState.Connected) {
                this.once("socket", (stat: SocketState) => {
                    if (stat === SocketState.Closed) {
                        resolve()
                    }
                })
            }
        })
    }

    public getState() {
        return this.stat
    }
}