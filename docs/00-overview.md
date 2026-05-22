# Kanbei 開発計画 — 全体検討メモ

最終更新: 2026-05-22 (主要 6 論点確定 + CLI Usage 仕様確定)

## 1. プロジェクト現状

- リポジトリには `README.md` と Git 初期コミット (`4f256c1`) のみ
- コード・設定ファイル・依存定義は一切なし
- README はコンセプト記述のみ。実装方針・技術スタックは未確定

## 2. README からの要求事項抽出

| # | 要件 | 種別 |
|---|------|------|
| R1 | GitHub Issue をインターフェイス層として使う | 機能 |
| R2 | Issue を読んで応答 (コメント) する | 機能 |
| R3 | 複数の専門エージェントが協調する (Listener / Spec / Architect / Builder / Tester) | アーキテクチャ |
| R4 | 仕様→アーキテクチャ→コード→テストの一連の流れを自動化 | 機能 |
| R5 | Pull Request を作成する | 機能 |
| R6 | Human-in-the-loop (Issue 上で人間と対話) | 機能 |
| R7 | リポジトリ規約に従ったコード生成 | 品質 |
| R8 | プラグイン式エージェント (将来) | 拡張性 |
| R9 | 長時間稼働の自律プロジェクト (将来) | 拡張性 |

## 3. 確定事項 (2026-05-22)

| 項目 | 採用 |
|------|------|
| 言語 | **TypeScript (Node.js)** |
| AI 呼び出し | **Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)** |
| 動作モデル | **CLI 先行 → GitHub Actions 拡張** の二段構え |
| 対象リポジトリ | **Kanbei 自身** (セルフホスティング) |
| Bot 認証 | **GitHub App** (App + Installation token 方式) |
| ドキュメント言語 | **ハイブリッド**: README / コード内コメント・識別子は英語、`docs/` は日本語 |

### セルフホスティングの含意
- Kanbei は将来 Kanbei リポジトリの Issue を自身で処理し、自身に PR を出す
- ただし P0〜P1 までは「鶏と卵」状態のため人間が手で作る
- Kanbei が動き始めるには事前にリポジトリを GitHub にリモート push しておく必要あり

### CLI Usage (確定 2026-05-22)

- バイナリ名: **`kanbei`**
- 基本形: **`kanbei <github-url>`** を主引数とする
  - `kanbei https://github.com/owner/repo` → リポジトリ全体の Kanbei ラベル付き Issue を巡回処理
  - `kanbei https://github.com/owner/repo/issues/42` → 特定 Issue を 1 サイクル処理
- サブコマンドは原則作らない。引数は URL を主役にし、フラグは本当に必要な場合のみ付け加える
- 補助フラグ (将来候補): `--once` (常駐ループしない明示), `--dry-run` (副作用を抑止), `--config <path>` (設定ファイル指定)

### GitHub App 採用の含意
- App private key (PEM) の安全な保管が必要 (ローカルは `.gitignore` 対象の `.env` / 本番は Secret Manager)
- 認証は `@octokit/auth-app` で JWT → Installation token フロー
- 対象リポジトリへの **install** ステップが運用手順に入る
- App に与える権限スコープを早期に決定する必要あり (issues:write, pull_requests:write, contents:write, metadata:read など)

以下は検討時の比較メモ (履歴として残す):

### 3.0 主要論点 (旧: 未決定事項)

### 3.1 動作モデル — どこで動くか
- **A. GitHub Actions** で Issue/PR イベント駆動
  - 長所: インフラ不要、GitHub と密結合、無料枠あり
  - 短所: 実行時間制限 (6h)、状態は外部 (Issue 本文 / labels / artifacts) に保持必要
- **B. 常駐サーバ (Webhook 受信 + バックグラウンドジョブ)**
  - 長所: 長時間/複雑な処理、状態管理が柔軟
  - 短所: 運用コスト (ホスティング、シークレット管理)
- **C. ローカル CLI** (`kanbei run <issue#>` のように手動起動)
  - 長所: 開発初期に最速で動く、デバッグ容易
  - 短所: 自律性なし。MVP / 開発用には最適

**推奨**: C (CLI) でコア機能を作り→ A (Actions) で自律化、を二段構え。

### 3.2 実装言語 / ランタイム
- **TypeScript (Node.js)**: octokit が最も充実、Claude Agent SDK の TS 版あり
- **Python**: Anthropic SDK が成熟、AI 周辺ライブラリ豊富、GitHub 連携は PyGithub
- **推奨**: TypeScript。GitHub 連携の体験と Claude Agent SDK のサポート品質で優位。

### 3.3 AI 呼び出し方式
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`): tool-use / ファイル編集ループが組み込み済み。Builder / Tester エージェント実装が圧倒的に楽
- **Anthropic SDK 直接呼び出し**: 細粒度制御は効くが、ループ・toolハーネスを自作する必要
- **推奨**: 各エージェントは Claude Agent SDK ベースで実装。Listener / Spec のような対話型は SDK の system prompt + tool 制限で表現。

### 3.4 エージェント間の状態・通信
- GitHub Issue 自体を状態機械にする案:
  - **Label** でフェーズ管理: `kanbei:gathering` → `kanbei:spec` → `kanbei:arch` → `kanbei:building` → `kanbei:review`
  - **Issue コメント** が会話履歴 = エージェントの記憶
  - **Issue 本文 (markdown セクション)** に仕様・アーキ図を蓄積
- 利点: 外部 DB 不要、人間にも全工程が可視

## 4. 推奨アーキテクチャ (たたき台)

```
GitHub Issue (state via labels)
       │
       ▼
  Kanbei Orchestrator
   (TypeScript, CLI 兼 Actions エントリ)
       │
       ├── Listener   ← 対話 / 質問生成
       ├── Spec       ← Issue 本文に仕様セクション追記
       ├── Architect  ← アーキ案を提示・確認
       ├── Builder    ← 別ブランチを切って実装、PR を開く
       └── Tester     ← PR にテスト追加 / CI 結果を要約
```

- 各エージェント = 単一の Claude Agent SDK セッション + 役割固有 system prompt + 許可ツール集合
- オーケストレータが現在の label を見て次に呼ぶエージェントを決定
- 人間の承認待ち = 専用 label (`kanbei:awaiting-human`) で停止

## 5. 段階的マイルストーン案

| Phase | ゴール | 主要成果物 |
|-------|--------|-----------|
| **P0** | プロジェクト基盤 | `package.json`, TS 設定, lint/format, CI スケルトン |
| **P1** | Issue 読み書き最小実装 | `kanbei` CLI: 指定 Issue を取得しコメント返信 |
| **P2** | Listener + Spec のループ | Issue 本文に「## Spec」セクションを自動生成 |
| **P3** | Builder で PR 自動作成 | 空に近い小規模 Issue で end-to-end が通る |
| **P4** | Architect / Tester 追加 | フル 5 エージェント |
| **P5** | GitHub Actions 化 | `issue_comment` トリガで自律動作 |
| **P6** | 拡張性 / プラグイン化 | カスタムエージェント差し込み口 |

## 6. リスク・要注意事項

- **権限**: PR 作成・コメントには `GITHUB_TOKEN` か PAT が必要。Actions の場合 `permissions:` 設定の漏れ注意。
- **無限ループ**: エージェントがエージェントのコメントに反応して暴走する可能性 → bot user 判定 / カウンタ必須。
- **コスト**: Claude API 利用料。トークン上限・回数上限のガードを最初から入れる。
- **シークレット**: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` の管理ポリシーを早めに決定。
- **冪等性**: 同じ Issue を再処理しても二重生成されないように label / コメントマーカーで判定。

## 7. 次アクション (推奨順)

1. **ユーザー判断**: §3.1〜§3.3 の方針確定
2. リポジトリ骨格 (P0) を作成
3. `docs/01-architecture.md` を起こして詳細アーキ確定
4. P1 (Issue 取得 + コメント) を最小実装し、動作確認

---

## 確定論点 (履歴, 2026-05-22 全件クローズ)

1. ✅ **動作モデル**: CLI 先行 → Actions 拡張の二段構え
2. ✅ **言語**: TypeScript
3. ✅ **AI 呼び出し**: Claude Agent SDK ベース
4. ✅ **対象リポジトリ**: Kanbei 自身 (セルフホスティング)
5. ✅ **Bot 認証**: GitHub App
6. ✅ **ドキュメント言語**: ハイブリッド (README/コードは英語、`docs/` は日本語)
