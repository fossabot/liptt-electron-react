import { Attribute, ForeColor, BackColor } from "./color"
/** 字塊 */
export class Block {
    /** 區塊內容(值範圍:0~0xFF) */
    public Content: number
    /** 背景色 */
    public Background: number
    /** 前景色 */
    public Foreground: number
    /** 屬性樣式 */
    public Attribute: Attribute

    constructor() {
        this.Default()
    }

    /** 重設 */
    public Default() {
        this.Content = 0x20
        this.Foreground = ForeColor.White
        this.Background = BackColor.Black
        this.Attribute = Attribute.None
    }

    /** 複製 */
    public Copy(b: Block) {
        this.Content = b.Content
        this.Background = b.Background
        this.Foreground = b.Foreground
        this.Attribute = b.Attribute
    }
}
