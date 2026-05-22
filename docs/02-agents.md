# Kanbei エージェント仕様

最終更新: 2026-05-22

`docs/01-architecture.md` で定義した枠組み (オーケストレータ・状態機械・コメント規約) の上に乗る、5 つの専門エージェントの責務・入出力・許可ツール・終了条件を定義する。

各エージェントは Claude Agent SDK の 1 セッションとして実装する。共通仕様と個別仕様に分けて記述する。

---

## 0. 共通仕様

### 0.1 入力 (オーケストレータが渡す)

すべてのエージェントは以下を入力として受け取る:

- `issue`: 対象 Issue (number, title, body, labels, author)
- `comments`: コメント時系列 (Kanbei 自身のマーカー付きコメントは **既に除去済み**)
- `repoContext`: リポジトリのメタ (default branch, languages, トップレベルファイル一覧、`CLAUDE.md` 抜粋)
- `previousAgentOutput`: 直前エージェントの構造化結果 (引き継ぎ情報)
- `safetyBudget`: 残り反復回数・残りトークン予算

### 0.2 出力 (オーケストレータが解釈する)

エージェントは終了時に以下の構造化結果を返す:

```ts
type AgentResult = {
  status:
    | 'ready_for_next_phase'   // 次フェーズへ遷移してよい
    | 'needs_human'            // 人間入力待ち
    | 'needs_retry'            // 同フェーズで再試行が必要
    | 'error';                 // 復旧不能
  nextPhase?: KanbeiPhase;     // status === 'ready_for_next_phase' のとき
  summary: string;             // オーケストレータログ用 1〜3 行
  questions?: string[];        // status === 'needs_human' のとき
};
```

- 副作用 (本文更新・コメント追加・PR 作成) は **エージェント実行中に SDK の許可ツール経由で済んでいる前提**。`AgentResult` は遷移判断のためのメタ情報のみ
- `nextPhase` をエージェントが指定するが、最終的な遷移可否はオーケストレータが安全装置を見て判断

### 0.3 共通システムプロンプトの方針

すべてのエージェントの system prompt に以下を必ず含める:

1. **役割と責務範囲** (個別)
2. **触ってよい対象** (Issue 本文の特定セクションのみ / コメント追加 / 等)
3. **触ってはいけない対象** (人間が書いた本文、他エージェントのセクション、他エージェントが作ったコメント)
4. **コメント書式規約**: 先頭に `<!-- kanbei:<agent> v1 -->`
5. **言語**: GitHub 上の発話 (コメント・PR 本文・コミットメッセージ) は **英語**
6. **終了条件**: いつ `ready_for_next_phase` / `needs_human` を返すか
7. **トークン予算**: 与えられた `safetyBudget` を超えないこと

### 0.4 許可ツールのカテゴリ

エージェント別に Claude Agent SDK の tool 許可を絞る。カテゴリは:

- `read.*`: GitHub からの取得 (Issue, コメント, ファイル, PR)
- `write.body.<section>`: Issue 本文の指定セクション更新 (`SPEC` / `ARCH` / `PLAN`)
- `write.comment`: Issue / PR コメント追加
- `repo.read`: リポジトリ内ファイル読み取り
- `repo.write`: ブランチ内ファイル編集 (Builder 専用)
- `repo.commit_push`: ブランチへのコミット+push (Builder 専用)
- `pr.open`: PR 作成 (Builder 専用)
- `pr.review_comment`: PR 行コメント (Tester 専用)
- `ci.read`: ワークフロー結果取得 (Tester 専用)

各エージェントの許可セットは個別仕様に記載。

---

## 1. Listener Agent

### 責務
人間が書いた自由文 Issue を読み、要件を引き出すための質問を生成する。あいまいさが解消されたら Spec へ引き継ぐ。

### 入力ハンドリング
- `issue.body` の人間記述部分 + 全コメント (Kanbei 発を除外済み) を読む
- 既に「Kanbei が質問 → 人間が回答」のラウンドが発生していれば、そのラリーから何が解消され何が残っているかを判定

### 出力ルール
- 不明点が **3 件以上** あるなら、優先度の高い順に最大 5 件、1 コメントにまとめて質問 → `needs_human`
- 不明点が **0 件** で要件が一通り揃ったら → `ready_for_next_phase` (`nextPhase: 'spec'`)、引き継ぎ要約を `summary` に
- 不明点が **1〜2 件** の場合は判断: 影響が大きいなら質問、小さければ前提として明文化し進める (前提は次の Spec フェーズで仕様の前提条件として記録)

### 許可ツール
- `read.issue`, `read.comments`, `repo.read` (README / 既存 docs を読んで文脈把握)
- `write.comment` (質問用)

### 触らないもの
- Issue 本文の人間記述部分
- 他のセクション (SPEC / ARCH / PLAN)

---

## 2. Spec Agent

### 責務
Listener が引き継いだ要件を、構造化された仕様に整形して Issue 本文の `<!-- KANBEI_SPEC_START -->`〜`END` セクションに書き込む。

### 出力構造 (SPEC セクションの markdown 雛形)

```markdown
## Specification

### Goals
- ...

### Non-goals
- ...

### Functional requirements
- FR1: ...
- FR2: ...

### Non-functional requirements
- NFR1: ...

### Assumptions
- A1: ...

### Acceptance criteria
- AC1: ...
```

### 終了条件
- 必須サブセクション (Goals / Functional / Acceptance) がすべて埋まり、矛盾がない → `ready_for_next_phase` (`nextPhase: 'arch'`)
- 仕様化中に不明点が出た → 質問コメントを 1 件追加して `needs_human`

### 許可ツール
- `read.issue`, `read.comments`, `repo.read`
- `write.body.SPEC`
- `write.comment` (質問時のみ)

### 触らないもの
- 人間本文、ARCH / PLAN セクション

---

## 3. Architect Agent

### 責務
SPEC セクションを読み、技術設計を ARCH セクションに記述。実装計画 (どのファイルをどう変更するか) も PLAN セクションに書き出す。

### 出力構造

ARCH セクション:
```markdown
## Architecture

### Approach
高レベル方針 (採用技術、パターン、依存追加方針)

### Component changes
- 新規 / 変更 / 削除ファイル一覧と役割

### Data model
(必要なら) スキーマ・型定義

### Interfaces
API・関数シグネチャ

### Risks & tradeoffs
- R1: ...
```

PLAN セクション:
```markdown
## Implementation Plan

1. [ ] Step 1: <具体的タスク>
2. [ ] Step 2: ...
```

### 終了条件
- ARCH と PLAN が両方埋まり、SPEC の Acceptance criteria を満たせる根拠があれば → `ready_for_next_phase` (`nextPhase: 'building'`)
- SPEC に致命的な不整合を発見 → SPEC への戻り (`needs_retry`, `summary` に理由) を依頼

### 許可ツール
- `read.issue`, `read.comments`, `repo.read`
- `write.body.ARCH`, `write.body.PLAN`
- `write.comment`

---

## 4. Builder Agent

### 責務
PLAN セクションのチェックリストを順に消化しながら、`kanbei/issue-<N>-<slug>` ブランチでコードを実装する。実装が一区切りついたら PR を作成。

### 動作概要
1. ブランチを作成または既存を再利用 (§01-architecture.md §6)
2. PLAN のステップを順に処理。各ステップ完了で 1 コミット (CLAUDE.md のコミット規約に従う英語メッセージ)
3. すべて完了したら PR を open。PR 本文に `Closes #<N>` を含める
4. PR 作成後、PLAN セクションのチェックを更新

### 終了条件
- PLAN 全項目を完了し PR を open → `ready_for_next_phase` (`nextPhase: 'testing'`)
- PLAN 実装中に SPEC / ARCH の不備を発見 → `needs_retry` で前フェーズへの差し戻し (summary に該当ステップと理由)
- どうしても進められない → `needs_human`

### 許可ツール
- `read.issue`, `read.comments`, `repo.read`
- `write.body.PLAN` (チェック更新のみ)
- `write.comment`
- `repo.write`, `repo.commit_push`
- `pr.open`

### 特記事項
- **自身のコードを書く際は CLAUDE.md と既存規約に厳密に従う**
- `.env` 等 gitignored ファイルや秘密情報は絶対にコミットしない
- 既存テストを壊さない (Builder 自身でテスト実行可能なら実行、不可なら Tester に委譲)

---

## 5. Tester Agent

### 責務
Builder が出した PR に対してテストを追加・補強し、CI 結果を確認する。テスト失敗時は原因要約コメントを残す。

### 動作概要
1. PR のブランチをチェックアウト想定で `repo.read` を使い、変更点を把握
2. 既存テストフレームワーク (vitest / jest 等、`package.json` から判定) に合わせてテストを追加
3. テストファイルをブランチに commit / push (Tester は Builder と同じブランチに追加コミットしてよい)
4. CI 完了を待ち、結果を PR コメントとして要約

### 終了条件
- テスト追加 + CI green → `ready_for_next_phase` (`nextPhase: 'review'`)
- CI red で原因が Builder の実装にある → `needs_retry` で Builder に戻す
- CI red で原因が SPEC / ARCH の問題 → `needs_retry` でより前のフェーズへ
- 致命的なテスト戦略課題 → `needs_human`

### 許可ツール
- `read.issue`, `read.comments`, `repo.read`
- `repo.write`, `repo.commit_push` (テストファイルのみ — プロダクトコードは触らない)
- `write.comment`, `pr.review_comment`
- `ci.read`

### 触らないもの
- プロダクトコード本体 (Builder の領分)
- Issue 本文セクション (SPEC / ARCH / PLAN)

---

## 6. エージェント間の責任境界 (まとめ)

| 対象 | Listener | Spec | Architect | Builder | Tester |
|------|:--------:|:----:|:---------:|:-------:|:------:|
| Issue 本文 (人間部分) | 読 | 読 | 読 | 読 | 読 |
| SPEC セクション | — | 書 | 読 | 読 | 読 |
| ARCH セクション | — | — | 書 | 読 | 読 |
| PLAN セクション | — | — | 書 | 書 (チェック更新) | 読 |
| Issue コメント | 書 | 書 | 書 | 書 | 書 |
| プロダクトコード | — | — | — | 書 | 読 |
| テストコード | — | — | — | 書 | 書 |
| ブランチ作成 | — | — | — | 〇 | — |
| PR open | — | — | — | 〇 | — |
| PR コメント | — | — | — | 書 | 書 |

「書」は対応するセクション / コメントマーカーに限る。他エージェントの成果物は読むだけで書き換えない。

---

## 7. 残課題

- 各エージェントの system prompt 本文 (テンプレート) は P2〜P4 で実装時に確定
- `repoContext` の生成ロジック (どこまで自動で渡し、何を要求時取得とするか) は P1 で詳細化
- Builder の自己テスト機構 (Builder が自分の差分をローカル実行できるか) → 初期は Tester 任せ、後で Builder 内に取り込み検討
- 人間が直接 PR にコメントしたとき、Tester ループにどう反映するか → P4 で設計
