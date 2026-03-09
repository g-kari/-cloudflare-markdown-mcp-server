DEVBOX := devbox run

.PHONY: help install start deploy build type-check \
        secret-account-id secret-api-token secret-list \
        logs inspector setup

# デフォルト: ヘルプ表示
help:
	@echo "Cloudflare Markdown MCP Server"
	@echo ""
	@echo "使用方法: make <コマンド>"
	@echo ""
	@echo "開発:"
	@echo "  install           依存パッケージをインストール"
	@echo "  start             ローカル開発サーバー起動 (http://localhost:8788)"
	@echo "  build             TypeScript型チェック"
	@echo "  type-check        TypeScript型チェック (buildと同じ)"
	@echo "  inspector         MCP Inspectorを起動してツールをテスト"
	@echo ""
	@echo "デプロイ:"
	@echo "  deploy            Cloudflare Workersにデプロイ"
	@echo "  logs              デプロイ済みWorkerのログをリアルタイム確認"
	@echo ""
	@echo "シークレット設定:"
	@echo "  secret-account-id  CLOUDFLARE_ACCOUNT_ID を設定"
	@echo "  secret-api-token   CLOUDFLARE_API_TOKEN を設定"
	@echo "  secret-list        設定済みシークレット一覧を確認"
	@echo ""
	@echo "セットアップ:"
	@echo "  setup             初回セットアップ (install + シークレット設定)"

# 依存パッケージインストール
install:
	devbox run -- npm install

# ローカル開発サーバー起動
start:
	$(DEVBOX) start

# TypeScript型チェック
build:
	$(DEVBOX) build

type-check:
	$(DEVBOX) type-check

# Cloudflare Workersにデプロイ
deploy:
	$(DEVBOX) deploy

# デプロイ済みWorkerのログ確認
logs:
	$(DEVBOX) logs

# MCP Inspectorでテスト
inspector:
	$(DEVBOX) inspector

# シークレット設定
secret-account-id:
	$(DEVBOX) secret:account-id

secret-api-token:
	$(DEVBOX) secret:api-token

secret-list:
	$(DEVBOX) secret:list

# 初回セットアップ
setup: install
	@echo ""
	@echo "=== シークレット設定 ==="
	@echo "CLOUDFLARE_ACCOUNT_IDを入力してください:"
	$(DEVBOX) secret:account-id
	@echo "CLOUDFLARE_API_TOKENを入力してください:"
	$(DEVBOX) secret:api-token
	@echo ""
	@echo "セットアップ完了! 'make start' でローカルサーバーを起動できます。"
