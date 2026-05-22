# Kanbei セットアップ手順

最終更新: 2026-05-22 (kanbei init / GitHub Actions 追記 / App トークン自動生成)

ローカルで `kanbei <github-url>` を動かすまでの初回セットアップ手順。基本方針は `docs/00-overview.md` / 認証フローの詳細は `docs/01-architecture.md` §7。

---

## 0. 前提

- Node.js 20 以上 (このリポは `mise` で管理することを想定。`node --version` で 20+ を確認)
- `git`
- GitHub アカウント
- Anthropic API キー

---

## 1. GitHub App を作成する

Kanbei は人間ではなく **Bot** として Issue にコメントし PR を作るため、GitHub App を 1 つ作成する。個人 PAT (Personal Access Token) は使わない (`docs/00-overview.md` §3.5 / `docs/01-architecture.md` §7)。

### 1.1 App の作成

1. GitHub にログインし、以下のいずれかで App 作成画面を開く:
   - 個人アカウントに紐づける場合: `Settings → Developer settings → GitHub Apps → New GitHub App`
   - Organization に紐づける場合: `Org Settings → Developer settings → GitHub Apps → New GitHub App`
2. 入力項目:

| 項目 | 値 |
|------|----|
| GitHub App name | `kanbei-bot` (一意である必要あり。重複したら `kanbei-bot-<yourname>` 等で回避) |
| Homepage URL | このリポジトリの URL でよい (例: `https://github.com/<owner>/kanbei`) |
| Webhook → Active | **OFF** (P5 でオンにする。それまでは Webhook 不要) |
| Repository permissions | 下記 §1.2 参照 |
| Where can this GitHub App be installed? | **Only on this account** (推奨。後で広げられる) |

3. 「Create GitHub App」を押す。

### 1.2 必要な Repository permissions

最小権限の原則に従い以下だけを `Read & write` / `Read-only` に設定:

| Permission | レベル | 用途 |
|------------|--------|------|
| Contents | Read & write | ブランチ作成・ファイル編集・push (Builder) |
| Issues | Read & write | Issue 本文編集・ラベル付け替え・コメント |
| Pull requests | Read & write | PR 作成・PR コメント |
| Metadata | Read-only | (デフォルトで必須) |
| Actions | Read-only | CI 実行結果取得 (Tester) |
| Checks | Read-only | チェック結果取得 (Tester) |

それ以外は **No access** のままにする。

### 1.3 Subscribe to events

P0〜P4 (CLI モード) では **何もチェック不要**。P5 (Actions / Webhook 駆動) で以下を有効化する:

- Issues
- Issue comment
- Pull request
- Pull request review

---

## 2. App ID と Private Key を控える

App 作成完了後の画面で:

1. **App ID** をメモする (数値, 例: `1234567`)
2. ページ下部 **Private keys → Generate a private key** をクリック。`.pem` ファイルが自動ダウンロードされる
3. ダウンロードした PEM ファイルを **安全な場所** に保存
   - 推奨: リポジトリ外の隠しディレクトリ (例: `~/.config/kanbei/app.pem`)
   - リポ内に置く場合は `.gitignore` 済みの `.env` 経由で参照する。**絶対にコミットしない**
   - PEM 自体は `.gitignore` の `*.pem` パターンで弾かれるはず

---

## 3. App を対象リポジトリにインストールする

1. 作成した App の設定画面 → 左メニュー **Install App**
2. 対象アカウント / Org の右の `Install` をクリック
3. 対象リポジトリを選択:
   - セルフホスティング想定なら Kanbei リポジトリ自身
   - 「Only select repositories」で 1〜数個に絞るのが安全
4. インストール後、ブラウザの URL が以下の形になる:
   ```
   https://github.com/settings/installations/<INSTALLATION_ID>
   ```
   この **Installation ID** (数値) もメモする。

---

## 4. `.env` を作成する

リポジトリ直下で:

```bash
cp .env.example .env
```

`.env` を編集して以下を埋める:

```env
ANTHROPIC_API_KEY=sk-ant-...
KANBEI_APP_ID=1234567
KANBEI_APP_INSTALLATION_ID=98765432

# どちらか一方だけを設定 (両方設定はエラー):
KANBEI_APP_PRIVATE_KEY_PATH=/home/you/.config/kanbei/app.pem
# or
# KANBEI_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"

# 既定の対象リポジトリ (CLI で --repo 省略時に使う、任意)
KANBEI_REPO=owner/repo
```

> **Tip**: `KANBEI_APP_PRIVATE_KEY_PATH` (ファイルパス) のほうが、`.env` に PEM 本文を貼るより事故りにくい (改行エスケープのミスがない)。

---

## 5. リポジトリに Kanbei ラベルを準備する

Kanbei は Issue ラベルでフェーズ管理する (`docs/01-architecture.md` §2)。以下のラベルを対象リポジトリに作成しておく:

- `kanbei:gathering`
- `kanbei:spec`
- `kanbei:arch`
- `kanbei:building`
- `kanbei:testing`
- `kanbei:review`
- `kanbei:awaiting-human`
- `kanbei:done`
- `kanbei:error`

色は自由。後で `kanbei.config.yaml` の `labels.phases` を書き換えれば、既存の命名規約に合わせて変更も可能。

**`kanbei init` で自動作成 (推奨)**:

```bash
npx tsx src/cli/index.ts init https://github.com/owner/repo
```

9 個のラベルを一括作成する。既に存在するラベルはスキップするので冪等に実行できる。
`--config` で別の `kanbei.config.yaml` を指定した場合はそのプレフィックス・マッピングを使用する。

---

## 6. 動作確認

依存をインストール:

```bash
npm install
```

`.env` 設定後の動作確認 (`--dry-run` は GitHub 認証・書き込みをスキップする):

```bash
# リポジトリ URL — ラベル付き Issue をスキャンする
npx tsx src/cli/index.ts run https://github.com/owner/repo --dry-run

# Issue URL — その Issue を 1 サイクル処理する
npx tsx src/cli/index.ts run https://github.com/owner/repo/issues/1 --dry-run

# ラベル初期化 (dry-run なし — GitHub App 認証が必要)
npx tsx src/cli/index.ts init https://github.com/owner/repo
```

テスト全件 pass を確認:

```bash
npm test
```

---

## 7. トラブルシューティング

- **`Missing required env var KANBEI_APP_ID`** → `.env` を読み込めていない。CLI から起動する場合、`dotenv` ロードはオーケストレータ起動時 (P1) に行う。手動で `source .env` してから実行するか、Pure ローダ呼び出しは `process.env` を渡すだけなのでテスト用には任意の object を注入できる
- **`GitHub App private key does not look like a PEM`** → PEM ファイルの中身を `cat` で確認し、`-----BEGIN ... PRIVATE KEY-----` で始まっているか確認
- **`Multiple Kanbei phase labels present`** → 対象 Issue に複数の `kanbei:<phase>` ラベルが付いている。GitHub UI で 1 つだけ残す
- **PEM が GitHub にコピーされてしまった疑い** → 即座に App 設定画面で `Delete` → 新しい Private key を発行。漏れた鍵は revoke 必須

---

## 8. GitHub Actions (自律モード)

`.github/workflows/kanbei.yml` が含まれているので、以下の **Repository secrets** を設定するだけで自律動作が有効になる:

| Secret 名 | 値 |
|-----------|-----|
| `KANBEI_APP_ID` | GitHub App の App ID (数値) |
| `KANBEI_APP_PRIVATE_KEY` | PEM 本文 (改行含む) |
| `ANTHROPIC_API_KEY` | Anthropic API キー |

`KANBEI_APP_INSTALLATION_ID` と `KANBEI_GITHUB_TOKEN` は **不要**。  
ワークフローが `actions/create-github-app-token@v1` を使ってインストールトークンを自動生成し、Installation ID も出力から取得する。

トリガー条件:
- **`kanbei:` ラベルを Issue に付けた瞬間** → `run` コマンドが起動
- **`kanbei:awaiting-human` の Issue に人間がコメントした瞬間** → `run` で Listener が回答を拾う

同一 Issue への並列実行は `concurrency` グループで直列化される。

### 無効化

`KANBEI_DISABLED=true` を環境変数 / `.env` に設定すると Safety の L5 kill switch が働き、どの Issue も処理されない。

---

## 9. 残課題

- `kanbei.config.yaml` の `branchPattern` を Organizations 規約に合わせる
- マルチリポジトリ対応 (現在はセルフホスティング前提)
- `npm publish` 対応 (現在 `"private": true`)
