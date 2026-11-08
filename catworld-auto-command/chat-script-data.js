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
        { who: 'A', text: '哈囉 你這個週末有安排嗎' },
        { who: 'B', text: '還沒 可能在家' },
        { who: 'A', text: '在家喔 那你都做什麼／我最近週末都在補眠' },
        { who: 'B', text: '打遊戲 看影片' },
        { who: 'A', text: '聽起來很舒服欸 我也想這樣' },
        { who: 'B', text: '那就別排太滿' },
        { who: 'A', text: '說得也是 不過家裡的零食吃完了／又要出門買' },
      ],
    },
    {
      id: 'builtin-3',
      lines: [
        { who: 'A', text: '這麼晚你還沒睡喔' },
        { who: 'B', text: '剛打完一場' },
        { who: 'A', text: '我也是欸／明明明天還有事 還是捨不得睡' },
        { who: 'B', text: '通常都這樣' },
        { who: 'A', text: '對 越晚越清醒 這是什麼奇怪的體質' },
        { who: 'B', text: '習慣而已' },
        { who: 'A', text: '好吧 那你打算什麼時候睡' },
        { who: 'B', text: '現在就下線' },
      ],
    },
  ],
};
