// 劇本對話的內建備援劇本（只在 background 載入，content script 不載）：共用試算表沒填或抓不到時用。
// 內建劇本不放 {對方}：那要求兩台都填對方的角色名而且一字不差，備援劇本不該有這個前提。每一句都要能通過 chat-script.js 的 usableScripts（沒有分號、@等待、換行）。
globalThis.CatworldChatScriptData = {
  scripts: [
    {
      id: 'builtin-1',
      lines: [
        { who: 'A', text: '欸 你今天有上線喔' },
        { who: 'B', text: '有啊 剛下班' },
        { who: 'A', text: '最近怎麼都好忙／連玩遊戲的時間都快沒了' },
        { who: 'B', text: '對啊 我也是' },
        { who: 'A', text: '那等等一起練功嗎' },
        { who: 'B', text: '好啊 十分鐘後' },
        { who: 'A', text: '先說好 我練到一半可能會去吃東西' },
        { who: 'B', text: '隨你 我也要先喝水' },
      ],
    },
    {
      id: 'builtin-2',
      lines: [
        { who: 'A', text: '哈囉 你最近都在忙什麼' },
        { who: 'B', text: '沒什麼 上班 回家 打遊戲' },
        { who: 'A', text: '聽起來很規律欸／我最近都在補眠 怎麼睡都不夠' },
        { who: 'B', text: '我也常這樣' },
        { who: 'A', text: '有時候真想把行程全部清掉／什麼都不管' },
        { who: 'B', text: '那就找一天什麼都不排' },
        { who: 'A', text: '說得也是 不過家裡的零食吃完了／又要出門買' },
      ],
    },
    {
      id: 'builtin-3',
      lines: [
        { who: 'A', text: '欸 你現在有空嗎／想問你一個遊戲的問題' },
        { who: 'B', text: '有 怎麼了' },
        { who: 'A', text: '我最近練功總覺得進度很慢／不知道是不是哪裡做錯了' },
        { who: 'B', text: '你都在同一個地方練嗎' },
        { who: 'A', text: '對耶 一直重複有點膩／你有什麼心得嗎' },
        { who: 'B', text: '我會換地方練 比較不會膩' },
        { who: 'A', text: '換地方喔 聽起來有道理／我平常都懶得走遠 今天來試試' },
        { who: 'B', text: '有結果跟我說' },
      ],
    },
  ],
};
