#!/usr/bin/env python3
"""
Lista los alias de conexión SAP descubiertos automáticamente en la carpeta
de Keeper "Claude Connections" (y sus subcarpetas, una por empresa).

Uso: list_connections.py
Imprime en stdout un JSON: [{"alias": "...", "ambiguous": bool}, ...].
No imprime ningún dato sensible: ni siquiera el recordUid hace falta para
esto, solo nombres de carpeta/título ya visibles en el propio vault.
"""
import json
import sys

from _common import discover_connections, load_authenticated_params, LoginRequiredError, LOGIN_REQUIRED_MARKER


def main():
    try:
        params = load_authenticated_params()
    except LoginRequiredError:
        print(LOGIN_REQUIRED_MARKER, file=sys.stderr)
        sys.exit(2)

    try:
        aliases = discover_connections(params)
    except Exception as exc:
        print(f"DISCOVERY_ERROR: {exc}", file=sys.stderr)
        sys.exit(3)

    result = [{"alias": alias, "ambiguous": len(uids) > 1} for alias, uids in sorted(aliases.items())]
    print(json.dumps(result))


if __name__ == "__main__":
    main()
