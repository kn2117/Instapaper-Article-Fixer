.PHONY: backend frontend

backend:
	cd backend && npm run dev

frontend:
	cd frontend && npm run dev

dev:
	npm run dev