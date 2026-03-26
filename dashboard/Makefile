.PHONY: build build-server build-web dev install clean

# Build everything
build: build-server build-web

build-server:
	CGO_CFLAGS="-DSQLITE_ENABLE_FTS5" go build -o ccd-dashboard .

build-web:
	cd web && npm ci --silent && npm run build

# Dev mode: run both servers
dev:
	@echo "Terminal 1:  go run . serve"
	@echo "Terminal 2:  cd web && npm run dev"

# Install: build + register hooks (use top-level install.sh instead)
install: build
	@chmod +x hooks/dashboard-notify.sh
	@echo ""
	@echo "✓ Dashboard built"
	@echo "  Run ../install.sh to register hooks"
	@echo "  Start:  ./ccd-dashboard serve"

clean:
	rm -f ccd-dashboard
	rm -rf web/dist web/node_modules
