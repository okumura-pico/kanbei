# Kanbei アーキテクチャ詳細

最終更新: 2026-05-22 (CLI Usage を URL 主引数に整合)

`docs/00-overview.md` で確定した方針を前提に、システム内部の構造・状態遷移・安全装置を詳細化する。エージェント個別の system prompt や許可ツール集合は `docs/02-agents.md` に切り分ける。

---

## 1. システム構成

```
                   ┌─────────────────────────────┐
                   │   GitHub (Issue / PR / Repo) │
                   └──────────────┬──────────────┘
                                  │ Webhook / Polling
                                  ▼
                       ┌─────────────────────┐
                       │   Orchestrator      │
                       │  (TypeScript)       │
                       └──────────┬──────────┘
                                  │ dispatch by label
        ┌──────────┬──────────────┼──────────────┬──────────┐
        ▼          ▼              ▼              ▼          ▼
   ┌────────┐ ┌────────┐    ┌──────────┐   ┌────────┐  ┌────────┐
   │Listener│ │  Spec  │    │Architect │   │Builder │  │ Tester │
   └────────┘ └────────┘    └──────────┘   └────────┘  └────────┘
        ▲          ▲              ▲              ▲          ▲
        └──────────┴──────────────┴──────────────┴──────────┘
                  Claude Agent SDK (per-role session)
```

- **Orchestrator** は単一プロセス。現在の Issue を読み、ラベルから次に起動すべきエージェントを選び、エージェントの結果 (コメント追記、Issue 本文更新、ラベル付け替え、PR 作成) を観察して終了判定する
- **エージェント** は Claude Agent SDK の 1 セッション = 役割固有 system prompt + 許可ツール集合。各エージェントは「自分の出力で Issue / リポジトリに何を書くか」を SDK の tool 呼び出しとして発行する
- **GitHub Webhook 経路** は Phase 5 (Actions 化) で導入。それまでは CLI 呼び出しが起点

## 2. Issue 状態機械

Issue は Kanbei ラベル 1 つでフェーズを表す。

| Label | 意味 | 次に動くエージェント |
|-------|------|---------------------|
| `kanbei:gathering` | 要件ヒアリング中 | Listener |
| `kanbei:spec` | 仕様化中 | Spec |
| `kanbei:arch` | アーキ設計中 | Architect |
| `kanbei:building` | 実装中 | Builder |
| `kanbei:testing` | テスト追加・検証中 | Tester |
| `kanbei:review` | PR 出した、人間レビュー待ち | (停止) |
| `kanbei:awaiting-human` | 質問待ちで人間入力必要 | (停止) |
| `kanbei:done` | 完了 | (停止) |
| `kanbei:error` | エラーで停止 | (停止) |

```
   (new issue)
       │ (人が `kanbei:gathering` を付与、もしくは Kanbei が自動付与)
       ▼
   gathering ──▶ awaiting-human ──▶ gathering   (Listener が人へ質問)
       │
       ▼ (Listener が要件整理完了と判断)
     spec ──▶ awaiting-human ──▶ spec
       │
       ▼
     arch ──▶ awaiting-human ──▶ arch
       │
       ▼
   building ──▶ testing
       │            │
       │            ▼
       └─────────▶ review (PR を open、人間マージ待ち)
                    │
                    ▼
                   done
                    │
   どこからでも ──▶ error (例外発生時)
```

- ラベル遷移は **常にオーケストレータが行う**。エージェント本体は遷移を指示せず「次フェーズへの引き継ぎ準備完了」を出力として返す
- 人間が手動でラベルを書き換えても破綻しないように、オーケストレータはラベル変更を真実の起点として扱う (idempotent)

## 3. Issue 本文の構造

Issue 本文は人間が最初に書いた自由文 + Kanbei が追記する markdown セクションで構成。Kanbei は **既存の人間の本文を絶対に書き換えない**。Kanbei セクションだけを置換する。

```markdown
<!-- KANBEI_HEADER_START -->
> Managed by Kanbei. Sections below are auto-generated.
<!-- KANBEI_HEADER_END -->

<元の人間が書いた本文がここに来る>

<!-- KANBEI_SPEC_START -->
## Specification
...
<!-- KANBEI_SPEC_END -->

<!-- KANBEI_ARCH_START -->
## Architecture
...
<!-- KANBEI_ARCH_END -->

<!-- KANBEI_PLAN_START -->
## Implementation Plan
...
<!-- KANBEI_PLAN_END -->
```

- 各セクションは `<!-- KANBEI_<NAME>_START -->` / `<!-- KANBEI_<NAME>_END -->` の HTML コメントマーカーで囲む
- セクション書き込みは「マーカー間を置換」操作で常に冪等
- マーカー外の本文・他セクションには触らない

## 4. コメント規約

エージェントが書く Issue / PR コメントは先頭行に必ず HTML コメントマーカーを入れる:

```markdown
<!-- kanbei:listener v1 -->
質問があります: 想定ユーザー数のオーダーは...
```

- `kanbei:<agent>` 部分でどのエージェントが書いたか識別
- `vN` はエージェント実装バージョン (将来の挙動変化追跡用)
- オーケストレータはこのマーカーを見て **Kanbei 自身のコメントを無視** することで自己反応ループを防止
- 加えて、GitHub App のユーザー ID チェック (`comment.user.type === 'Bot'` かつ `comment.user.login === '<app-name>[bot]'`) を二重チェックとして実装

## 5. 無限ループ・暴走防止

| 防御層 | 内容 |
|-------|------|
| L1: 自分のコメント無視 | §4 のマーカー + bot user 判定でループ起点を絶つ |
| L2: Issue 単位の反復上限 | 1 Issue あたりオーケストレータ起動回数を上限化 (デフォルト 50) |
| L3: フェーズ単位の上限 | 同一ラベル状態で N 回連続起動したら `kanbei:error` 化 (デフォルト 5) |
| L4: トークン予算 | Issue 単位の累積入出力トークン上限 (デフォルト Issue ごと 500K tokens) |
| L5: kill switch | リポジトリ変数 `KANBEI_DISABLED=true` で全動作を即停止 |

これらの設定値は `kanbei.config.yaml` (リポジトリ直下) で上書き可能。設定ファイル仕様は P1〜P2 で詳細化する。

## 6. 冪等性

すべての書き込みは「同じ Issue 状態で再実行しても結果が等しい」設計:

- **Issue 本文セクション**: マーカー間の置換のみ (§3)
- **ラベル**: `set` ではなく「現状を読んで変更が必要なら更新」
- **コメント**: 直近 N 件を取得し、同じマーカー+同じ意味の内容なら追加しない (内容の意味判定は SHA や明示マーカー id で簡易化)
- **PR**: 既に同 Issue 由来の open PR があれば新規作成せず、ブランチに force-push (ただし force-push は別ブランチ運用で限定)
- **ブランチ名**: `kanbei/issue-<N>-<slug>` 固定。Builder は同名ブランチを再利用

## 7. 認証フロー

```
.env (local) or Secret Manager (CI)
       │
       ├─ KANBEI_APP_ID
       ├─ KANBEI_APP_PRIVATE_KEY (PEM, multiline)
       ├─ KANBEI_INSTALLATION_ID (Kanbei リポへの install id)
       └─ ANTHROPIC_API_KEY
              │
              ▼
   @octokit/auth-app で JWT 生成
              │
              ▼
   Installation Token (1h 有効) を取得
              │
              ▼
   octokit instance を Orchestrator / 各エージェントが共有
```

- Installation Token は揮発させない (メモリのみ)。ログ出力禁止
- ローカル `.env` は `.gitignore` で除外、`.env.example` をコミット
- 必要 App 権限: `issues:write`, `pull_requests:write`, `contents:write`, `metadata:read`, `actions:read` (CI ログ参照用), `checks:read`
- 必要 App イベント (Phase 5 以降): `issues`, `issue_comment`, `pull_request`, `pull_request_review`

## 8. ディレクトリ構成 (案)

```
kanbei/
├── README.md
├── CLAUDE.md
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── kanbei.config.yaml          # ループ上限等の運用設定
├── docs/                       # 日本語の設計メモ
├── src/
│   ├── cli/                    # commander ベースの CLI エントリ
│   │   └── index.ts
│   ├── orchestrator/           # ラベル遷移と起動判定
│   │   └── index.ts
│   ├── agents/
│   │   ├── listener.ts
│   │   ├── spec.ts
│   │   ├── architect.ts
│   │   ├── builder.ts
│   │   └── tester.ts
│   ├── github/                 # octokit ラッパ、body セクション編集、コメント規約
│   │   ├── client.ts
│   │   ├── body.ts
│   │   ├── comments.ts
│   │   └── labels.ts
│   ├── config/                 # kanbei.config.yaml ローダ
│   ├── safety/                 # 反復上限・トークン予算・kill switch
│   └── types.ts
├── tests/
└── .github/
    └── workflows/              # Phase 5 で追加
```

## 9. データフロー (1 サイクル)

```
1. CLI: `kanbei https://github.com/owner/repo/issues/42`
   → URL をパースして {owner, repo, issue: 42} を抽出
   → リポジトリ URL (Issue 番号なし) の場合は対象 Issue を Kanbei ラベル付き一覧から選定
2. Orchestrator:
   a. Octokit 認証 (Installation Token)
   b. Issue #42 を取得
   c. Safety checks (L2/L3/L4/L5)
   d. ラベル参照 → 起動エージェントを決定 (例: kanbei:spec → Spec)
3. Spec Agent (Claude Agent SDK セッション):
   a. system prompt + Issue 本文 + 最新コメント (Kanbei 発を除外) を投入
   b. 許可ツール経由で Issue 本文の SPEC セクションを更新
   c. 必要なら人間への質問コメントを 1 件追加
   d. 終了判定 (「仕様完成」/「人間入力待ち」/「次フェーズへ」)
4. Orchestrator:
   a. エージェント結果からラベル遷移を実行
   b. メトリクス記録 (反復回数 +1、累積トークン更新)
5. 終了 (or 次フェーズへ Goto 2)
```

## 10. 残課題 (このドキュメントから次に詰める)

- 各エージェントの system prompt 骨子と許可ツール集合 → **`docs/02-agents.md`**
- `kanbei.config.yaml` の正式スキーマ → P1〜P2 実装時
- ログ・観測 (構造化ログ、各エージェント発話の保存方法) → P1 着手時
- Phase 5 (Actions 化) の workflow yaml 設計 → P5 着手時
- セルフホスティング時のブートストラップ手順 (鶏と卵問題) → P3 直前に明文化
