# ae-mcp-server

Adobe After Effects を AI アシスタント(Claude Desktop / Claude Code など)から操作するための MCP サーバーです。
An MCP server that lets AI assistants control Adobe After Effects through ExtendScript.

## 仕組み

1. MCP クライアントがツールを呼び出す
2. サーバーが ExtendScript (JSX) を一時ファイルとして生成
3. macOS は `osascript`(`DoScript`)、Windows は `AfterFX.exe -r` で起動中の After Effects に実行させる
4. JSX が結果を JSON ファイルに書き出し、サーバーがそれを読んで MCP クライアントに返す

After Effects は同時に1つのスクリプトしか実行できないため、呼び出しは内部でキューに積まれます。

## 必要なもの

- After Effects(macOS / Windows)
- Node.js 18 以上
- After Effects の設定 **環境設定 > スクリプトとエクスプレッション > 「スクリプトによるファイルの書き込みとネットワークへのアクセスを許可」** をオン
  (結果ファイルの書き出しに必要です)

## インストール

```bash
git clone https://github.com/<your-name>/ae-mcp-server.git
cd ae-mcp-server
npm install
npm run build
```

## MCP クライアントへの登録

### Claude Code

```bash
claude mcp add after-effects -- node /absolute/path/to/ae-mcp-server/dist/index.js
```

### Claude Desktop(`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "after-effects": {
      "command": "node",
      "args": ["/absolute/path/to/ae-mcp-server/dist/index.js"]
    }
  }
}
```

## 環境変数

| 変数 | 説明 |
| --- | --- |
| `AE_APP_NAME` | (macOS) 対象アプリ名。例: `Adobe After Effects 2026`。未指定なら `/Applications` から最新版を自動検出 |
| `AE_PATH` | (Windows) `AfterFX.exe` のフルパス。未指定なら `C:\Program Files\Adobe` から自動検出 |
| `AE_TIMEOUT_MS` | 1回のスクリプト実行の待機上限(ミリ秒、既定 60000) |

## ツール一覧

| ツール | 内容 |
| --- | --- |
| `ae_get_project_info` | AE バージョン、プロジェクトパス、アイテム一覧 |
| `ae_list_compositions` | コンポジション一覧 |
| `ae_create_composition` | コンポジション作成 |
| `ae_list_layers` | レイヤー一覧 |
| `ae_add_text_layer` | テキストレイヤー追加 |
| `ae_add_solid_layer` | 平面レイヤー追加 |
| `ae_add_shape_layer` | 矩形 / 楕円のシェイプレイヤー追加 |
| `ae_set_layer_transform` | 位置・スケール・回転・不透明度の設定(`time` 指定でキーフレーム) |
| `ae_add_effect` | エフェクト追加とプロパティ設定 |
| `ae_import_file` | ファイルのインポート(コンポへの追加も可) |
| `ae_render` | レンダーキューに追加してレンダリング |
| `ae_save_project` | 保存 / 名前を付けて保存 |
| `ae_run_jsx` | 任意の ExtendScript を実行(関数本体として評価され、`return` した値が返る) |

`ae_run_jsx` の例:

```js
// code
var comp = __findComp(args.comp);
return { name: comp.name, layers: comp.numLayers };
// args
{ "comp": "Main" }
```

ExtendScript は ES3 です(`let` / `const` / `JSON` / `Array.prototype.forEach` などは使えません)。
レイヤーの追加や変更は1つのアンドゥグループにまとめられるので、After Effects 側で一度 Undo すれば戻せます。

## 注意

- `ae_run_jsx` は任意のコードを実行できます。信頼できる MCP クライアントからのみ使ってください。
- スクリプト実行中に After Effects でダイアログが開いていると、タイムアウトします。
- `ae_render` は完了までブロックします(既定の待機上限は1時間)。

## ライセンス

MIT
