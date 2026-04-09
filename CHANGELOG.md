# Changelog - v0.1.0

## 🎯 Hlavní změny

### Odstraněn chat participant (@qwen)
- **Důvod:** Chyba `mgt.clearMarks is not a function` a duplicitní funkcionalita
- **Řešení:** Extension nyní používá pouze standardní model picker v Copilot Chat
- **Výhody:** 
  - Čistší architektura
  - Žádné chyby s markdown rendererem
  - Konzistentní UX s ostatními Copilot extensionmi

### Přidána retry logika pro síťové požadavky
- **Exponenciální backoff:** 1s → 2s → 4s mezi pokusy
- **Opakování při:** 
  - 429 Too Many Requests (rate limit)
  - 500-504 Server errors
- **Maximální zpoždění:** 10 sekund
- **Náhodný jitter:** ±30% pro prevenci hromadných požadavků
- **Respektování zrušení:** Při stisku "stop" se retry neprovádí

### Tool Calling podpora (příprava)
- Přidány typy pro OpenAI function calling
- Implementováno parsování tool_calls v stream handleru
- Aktuálně nastaveno `toolCalling: false` 
- Připraveno pro budoucí implementaci VS Code tool integration

## 📦 Technické změny

### Aktualizované závislosti
```json
"engines": {
  "vscode": "^1.94.0"     // bylo: ^1.90.0
},
"devDependencies": {
  "@types/vscode": "^1.94.0"  // bylo: ^1.90.0
}
```

### Odstraněné soubory
- `src/participant.ts` - není potřeba
- `out/participant.js` - zkompilovaná verze
- `out/participant.js.map` - source map

### Aktualizované soubory
- `src/extension.ts` - odstraněna reference na participant
- `src/provider.ts` - přidána retry logika a tool calling typy
- `package.json` - odstraněn chatParticipants z contributes
- `README.md` - aktualizována dokumentace
- `tsconfig.json` - přidány lepší compiler options
- `.vscodeignore` - ignorování nepotřebných souborů

### Nové soubory
- `LICENSE.md` - MIT licence (vyžadováno pro publikaci)
- `CHANGELOG.md` - tento soubor

## 🐛 Opravené chyby

### v0.0.x
- `mgt.clearMarks is not a function` - odstraněním participantu
- Nekonzistentní base URL mezi provider a participant
- Chybějící retry logika pro production použití

### v0.1.0
- Všechny známé issues vyřešeny

## 🚀 Jak aktualizovat

```bash
# Odinstalovat starou verzi
code --uninstall-extension MartinRiha.vscode-custom-llm-provider

# Nainstalovat novou verzi
code --install-extension vscode-custom-llm-provider-0.1.0.vsix
```

## 📝 Poznámky k migraci

Pokud jste používali `@qwen` příkaz v Copilot Chat:
1. Otevřete Copilot Chat (`Ctrl+Alt+I`)
2. Klikněte na název modelu v horní části chatu
3. Vyberte libovolný Qwen model z nabídky
4. Nyní můžete chatovat přímo s vybraným modelem

## 🔮 Plánované funkce (budoucí verze)

- [ ] Plná tool calling podpora pro VS Code functions
- [ ] Vlastní tokenizér pro přesnější počítání tokenů
- [ ] Podpora pro system messages
- [ ] Konfigurovatelný retry policy v settings
- [ ] Metrics a telemetry pro monitorování chyb

---

**Vydané verze:**
- v0.1.0 (2026-03-31) - Major refactor, retry logic, tool calling准备
- v0.0.1 (2026-XX-XX) - Initial release
