import {
    FavoriteItem,
    FavoriteItemType,
    ArticleAbstract,
    ReadState,
    ArticleType,
    ArticleHeader,
    HotItem,
    PTTState,
    StateFilter,
    SocketState,
} from "../model"
import { Client, Control } from "../client"
import { Terminal, Block, TerminalHeight } from "../model/terminal"

export class LiPTT extends Client {

    /** "[]" "<>" "［］" "《》" */
    private readonly bracketReg = /[\u005b\u003c\uff3b\u300a]{1}[^\u005b\u003c\uff3b\u300a\u005d\u003e\uff3d\u300b]+[\u005d\u003e\uff3d\u300b]{1}/
    /** "()" */
    private readonly boundReg = /[\u0028]{1}[^\u0028\u0029]+[\u0029]{1}/
    private readonly titleRegex = /標題  (Re:|Fw:|)\s*(\[[^\[^\]]*\]|)\s*([\S\s]*)/
    private readonly timeRegex = /時間  ([A-Z][a-z]+) ([A-Z][a-z]+)\s*(\d+)\s*(\d+:\d+:\d+)\s*(\d+)/
    private readonly authorRegex = /作者  ([A-Za-z0-9]+) \(([\S\s^\(^\)]*)\)\s*(?:看板  )?([A-Za-z0-9\-\_]+)?/
    private readonly afootRegex = /瀏覽 第 ([\d\/]+) 頁 \(([\s\d]+)\%\)  目前顯示: 第\s*(\d+)\s*~\s*(\d+)\s*行/
    private scst: SocketState
    private curIndex: number
    private board: string
    private curArticle: ArticleHeader
    private curArticleEnd: boolean
    private snapshot: Terminal
    private snapshotStat: PTTState

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
        if (stat === PTTState.WhereAmI) {
            return
        }
        this.snapshot = term.DeepCopy()
        this.snapshotStat = stat
        this.emit("StateUpdated", term, stat)
    }

    private onStateUpdated(term: Terminal, stat: PTTState) {
        this.snapshotStat = stat
        if (this.snapshotStat === PTTState.MainPage) {
            this.curIndex = Number.MAX_SAFE_INTEGER
        }

        // Debug.log(StateString(this.snapshotState))
        // for (let i = 0; i < 24; i++) {
        //     Debug.log(term.GetString(i))
        // }
    }

    private onSocketChanged(stat: SocketState) {
        this.scst = stat
    }

    /** 建立連線, 然後登入 */
    public async login(user: string, pass: string): Promise<PTTState> {
        const result = await this.connect()
        if (result !== SocketState.Connected) {
            switch (result) {
            case SocketState.Failed:
                return PTTState.WebSocketFailed
            case SocketState.Closed:
                return PTTState.WebSocketClosed
            default:
                return PTTState.None
            }
        }

        const waitState = () => new Promise<PTTState>(resolve => {
            let c = 0
            const id = setInterval(() => {
                c++
                switch (this.snapshotStat) {
                case PTTState.Username:
                    clearInterval(id)
                    resolve(this.snapshotStat)
                    break
                case PTTState.Overloading:
                    clearInterval(id)
                    resolve(this.snapshotStat)
                    break
                default:
                    if (c > 30) {
                        clearInterval(id)
                        resolve(PTTState.Timeout)
                    } else {
                        resolve(this.snapshotStat)
                    }
                    break
                }
            }, 100)
        })

        let s = await waitState()
        while (s !== PTTState.Username) {
            if (s === PTTState.Overloading) {
                return s
            } else if (s === PTTState.Timeout) {
                return s
            }
            s = await waitState()
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

        while (stat !== PTTState.MainPage) {
            switch (stat) {
            case PTTState.Log:
                [, stat] = await this.Send(Control.No()) // 刪除錯誤的登入紀錄
                break
            case PTTState.AlreadyLogin:
                [, stat] = await this.Send(Control.Yes()) // 刪除重複的連線
                break
            case PTTState.AnyKey:
                [, stat] = await this.Send(Control.AnyKey())
                break
            default:
                [, stat] = await this.WaitForNext()
            }
        }
        return stat
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

        let term: Terminal = this.snapshot
        let stat: PTTState = this.snapshotStat
        while (stat !== PTTState.MainPage) {
            [term, stat] = await this.Send(Control.Left())
        }

        const items: FavoriteItem[] = []
        let ok = true;

        [term, stat] = await this.Send(Control.Favorite())

        let first = term.GetSubstring(3, 0, 2).trim()
        if (first !== "●" && first !== ">") {
            [term, stat] = await this.Send(Control.Home())
        }

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
                const description = term.GetSubstring(i, 30, 64).trim()
                if (itemType === FavoriteItemType.Folder) {
                    items.push({
                        key: index,
                        type: itemType,
                        name,
                        description,
                    })
                    continue
                }

                const popuStr = term.GetSubstring(i, 64, 67)
                const popularity: number = this.popular(popuStr, term.GetBlock(i, 66))

                items.push({
                    key: index,
                    type: itemType,
                    name,
                    description,
                    popularity,
                })
            }

            if (ok) {
                [term, stat] = await this.Send(Control.PageDown())
            }
        }

        first = term.GetSubstring(3, 0, 2).trim()
        if (first !== "●" && first !== ">") {
            [term, stat] = await this.Send(Control.Home())
        }
        await this.Send(Control.Left())
        return items
    }

    public async getHot(): Promise<HotItem[]> {
        let t: Terminal = this.snapshot
        let s: PTTState = this.snapshotStat
        while (s !== PTTState.MainPage) {
            [t, s] = await this.Send(Control.Left())
        }

        [t, s] = await this.Send(Control.Class())

        const items: HotItem[] = []
        let row = this.rowOfCursor(t)
        let right = t.GetString(row).includes("即時熱門看板")

        while (!right) {
            [t, s] = await this.Send(Control.Down())
            row = this.rowOfCursor(t)
            right = t.GetString(row).includes("即時熱門看板")
        }
        [t, s] = await this.Send(Control.Right())
        const first = t.GetSubstring(3, 0, 2).trim()
        if (first !== "●" && first !== ">") {
            [t, s] = await this.Send(Control.Home())
        }

        let ok = true
        while (s === PTTState.Hot && ok) {
            let i = 3
            const test = t.GetSubstring(3, 0, 2).trim()
            if (test !== "●" && test !== ">") {
                break
            }
            for (; i < 23; i++) {
                const indexStr = t.GetSubstring(i, 3, 7).trim()
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

                const type = t.GetSubstring(i, 23, 27).trim()
                const name = t.GetSubstring(i, 10, 22).trim()
                const description = t.GetSubstring(i, 30, 64).trim()

                const popuStr = t.GetSubstring(i, 64, 67)
                const popularity: number = this.popular(popuStr, t.GetBlock(i, 66))

                items.push({
                    key: index,
                    type,
                    name,
                    description,
                    popularity,
                })
            }

            if (ok) {
                [t, s] = await this.Send(Control.PageDown())
            }
        }

        await this.Send(Control.Home())
        while (s !== PTTState.MainPage) {
            [t, s] = await this.Send(Control.Left())
        }
        return items
    }

    public async enterBoard(board: string): Promise<boolean> {

        if (!/[0-9A-Za-z_\-]+/.test(board)) {
            return false
        }

        let t: Terminal
        let s: PTTState

        if (this.snapshotStat !== PTTState.MainPage) {
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
        if (this.snapshotStat === PTTState.Article) {
            await this.Send(Control.Left())
        } else if (this.snapshotStat !== PTTState.Board) {
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

    public async getArticleHeader(a: ArticleAbstract): Promise<ArticleHeader> {

        let h: ArticleHeader = {
            hasHeader: false,
            deleted: false,
        }

        let t: Terminal = this.snapshot
        let s: PTTState = this.snapshotStat

        const match = /^#[A-Za-z0-9_\-]{8}$/.exec(a.aid)
        if (!match) {
            h.deleted = true
            return h
        }

        if ((s !== PTTState.Board) && (s !== PTTState.Article)) {
            return {}
        }

        [t, s] = await this.goToArticle(a.aid)
        if (s === PTTState.Board) {
            [t, s] = await this.Send(Control.Right())
        } else {
            await this.Send(Control.AnyKey())
            h.deleted = true
            return h
        }

        if (s === PTTState.Article) {
            if (t.GetString(3).startsWith("───────────────────────────────────────")) {
                h.hasHeader = true
            }
            if (h.hasHeader === true) {
                h.url = a.url
                h.coin = a.coin
                const group0 = this.authorRegex.exec(t.GetString(0))
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
                const group1 = this.titleRegex.exec(t.GetString(1))
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
                const group2 = this.timeRegex.exec(t.GetString(2))
                if (group2) {
                    const g = group2.slice(1)
                    h.date = g.reduce((ans, cur) => ans + " " + cur)
                }
            }
            h = {...h, aid: a.aid, url: a.url, coin: a.coin}
            await this.Send(Control.Left())
        } else {
            h.deleted = true
            console.log("getArticleHeader(): article is not exist.")
            await this.Send(Control.AnyKey())
        }
        return h
    }

    private async goToArticle(aid: string) {
        return this.Send(aid, 0x0D)
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

    public async getMoreArticleContent(h: ArticleHeader): Promise<Block[][]> {

        if (!h.aid || !h.board) {
            this.curArticle = null
            this.curArticleEnd = false
            return []
        }

        if (!/^#[A-Za-z0-9_\-]{8}$/.test(h.aid)) {
            this.curArticle = null
            this.curArticleEnd = false
            return []
        }

        const reset: boolean = this.curArticle ? false : true

        if (!this.curArticle) {
            this.curArticle = {...h}
        }

        const regex = /瀏覽 第 ([\d\/]+) 頁 \(([\s\d]+)\%\)  目前顯示: 第\s*(\d+)\s*~\s*(\d+)\s*行/
        const lines: Block[][] = []
        let t: Terminal = this.snapshot
        const prev = t.DeepCopy()
        let s: PTTState = this.snapshotStat
        let pagedown = true

        while (this.snapshotStat !== PTTState.Article || h.aid !== this.curArticle.aid) {
            pagedown = false
            if (this.snapshotStat === PTTState.MainPage) {
                if (!h.board) {
                    return []
                }
                if (!await this.enterBoard(h.board)) {
                    return []
                }
            } else if (this.snapshotStat === PTTState.Board) {
                [t, s] = await this.Send(h.aid, 0x0D, 0x72)
                if (s !== PTTState.Article) {
                    this.curArticle = null
                    this.curArticleEnd = false
                    return []
                }
                this.curArticle = {...h}
                break
            } else if (this.snapshotStat === PTTState.Article) {
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

        function endTest(term: Terminal): boolean {
            const txt = term.GetString(23)
            const m = regex.exec(txt)
            if (m) {
                if (m[2] === "100") {
                    return true
                }
            }
            return false
        }

        function beginTest(term: Terminal): boolean {
            const txt = term.GetString(23)
            const m = regex.exec(txt)
            if (m) {
                if (parseInt(m[3], 10) === 1) {
                    return true
                }
            }
            return false
        }

        if (reset) {
            if (!beginTest(t)) {
                [t, s] = await this.Send(Control.Home())
            }
        } else if (pagedown) {
            if (endTest(t)) {
                return []
            }
            [t, s] = await this.Send(Control.PageDown())
        }

        const match = regex.exec(t.GetString(23))
        if (match) {
            let i = this.intersectPrev(prev, t)
            if (i === TerminalHeight) {
                const c0 = this.authorRegex.test(t.GetString(0))
                const c1 = this.titleRegex.test(t.GetString(1))
                const c2 = this.timeRegex.test(t.GetString(2))
                const c3 = t.GetString(3).startsWith("───────────────────────────────────────")
                i = c0 ? i - 1 : i
                i = c1 ? i - 1 : i
                i = c2 ? i - 1 : i
                i = c3 ? i - 1 : i
                const tmp = t.DeepCopy()
                lines.push(...tmp.Content.slice(TerminalHeight - i, TerminalHeight - 1))
            } else if (i > 0) {
                const prevm = regex.exec(prev.GetString(23))
                if (prevm) {
                    const pi = parseInt(prevm[3], 10)
                    const pj = parseInt(prevm[4], 10)
                    const mi = parseInt(match[3], 10)
                    const mj = parseInt(match[4], 10)
                    const predict = Math.max(mi - pi, mj - pj)
                    i = Math.max(i, predict)
                }
                const tmp = t.DeepCopy()
                lines.push(...tmp.Content.slice(TerminalHeight - i - 1, TerminalHeight - 1))
            }
            return lines
        } else {
            return []
        }
    }

    /** 判斷相交的偏移量 */
    private intersectPrev(prev: Terminal, next: Terminal): number {
        function equalLine(p: Block[], q: Block[]) {
            if (p.length !== q.length) {
                return false
            }
            for (let i = 0; i < p.length; i++) {
                if (!p[i].Equal(q[i])) {
                    return false
                }
            }
            return true
        }

        function intersect(pr: Terminal, ne: Terminal, offset: number): boolean {
            for (let k = offset; k < TerminalHeight - 1; k++) {
                if (!equalLine(pr.Content[k], ne.Content[k - offset])) {
                    return false
                }
            }
            return true
        }

        for (let i = 0; i < TerminalHeight - 1; i++) {
            if (intersect(prev, next, i)) {
                return i
            }
        }
        return TerminalHeight // 不相交
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
                    console.error(indexStr)
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
                author,
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

    private popular(popuStr: string, refBlock: Block) {
        let popu: number = 0
        switch (popuStr) {
        case "HOT":
            popu = 100
            break
        case "爆!":
            switch (refBlock.Foreground) {
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
        return popu
    }

    private rowOfCursor(term: Terminal): number {
        for (let i = 3; i < 23; i++) {
            const x = term.GetString(i).trimLeft()
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

    public checkEmail(): boolean {
        if (this.snapshot.GetSubstring(0, 30, 48).trim() === "你有新信件") {
            return true
        }
        return false
    }

    public async left(): Promise<void> {
        await this.Send(Control.Left())
    }

    private WaitForNext(): Promise<[Terminal, PTTState]> {
        return new Promise((resolve) => {
            this.once("StateUpdated", (term: Terminal, stat: PTTState) => {
                resolve([term.DeepCopy(), stat])
            })
        })
    }

    private Send(data: Buffer | Uint8Array | string | number, ...optionalParams: any[]): Promise<[Terminal, PTTState]> {
        return new Promise((resolve) => {
            this.once("StateUpdated", (term: Terminal, stat: PTTState) => {
                resolve([term.DeepCopy(), stat])
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
        return this.snapshotStat
    }
}
