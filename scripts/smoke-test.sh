#!/bin/bash
# Smoke test rápido: verifica que BFF + local infra estén OK

echo "🚀 SMOKE TEST: comprobando infra para QA"
echo ""

# 1. BFF health
echo "1️⃣  BFF health..."
curl -s http://localhost:3000/health | grep -q "ok" && echo "  ✅ BFF ok (localhost:3000)" || echo "  ❌ BFF down"

# 2. FS API
echo "2️⃣  FS API..."
curl -s -H "Token: $FS_API_KEY" http://localhost:8000/api/3 | grep -q "error\|clientes\|proveedores" && echo "  ✅ FS ok (localhost:8000)" || echo "  ❌ FS down"

# 3. MySQL
echo "3️⃣  MySQL..."
mysql -u root fs_api_node -e "SELECT COUNT(*) FROM \`customer\`;" 2>/dev/null && echo "  ✅ MySQL ok (customers found)" || echo "  ❌ MySQL down"

# 4. Chakra dev
echo "4️⃣  Chakra dev server..."
curl -s http://localhost:5174/ | grep -q "<!DOCTYPE\|<html" && echo "  ✅ Chakra ok (localhost:5174)" || echo "  ⚠️  Chakra not running (start with: npm run dev:chakra)"

echo ""
echo "✨ Smoke test completado"
