#!/usr/bin/env python3
"""
Puente no interactivo entre lib/connection.js y Keeper Commander.

Uso: fetch_secret.py <alias>

<alias> es uno de los que devuelve list_connections.py: el título del
registro si está directamente en la carpeta "Claude Connections", o
"<subcarpeta>/<título>" si está dentro de una subcarpeta (una por
empresa/servidor).

Reutiliza la sesión persistente creada por login.py (nunca pide
credenciales por consola: si no hay sesión válida, falla rápido con el
marcador KEEPER_LOGIN_REQUIRED en stderr en vez de quedarse esperando un
input() que aquí nunca va a llegar).

Imprime en stdout un JSON {host, client, user, password} con los campos
del registro de Keeper. No debe imprimir nunca ese contenido en stderr ni
en mensajes de error: los fallos solo describen el tipo de problema, nunca
los valores del registro.
"""
import json
import sys

from _common import (
    discover_connections,
    get_field,
    load_authenticated_params,
    LoginRequiredError,
    LOGIN_REQUIRED_MARKER,
)


def main():
    if len(sys.argv) != 2:
        print("Uso: fetch_secret.py <alias>", file=sys.stderr)
        sys.exit(1)
    alias = sys.argv[1]

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

    matches = aliases.get(alias)
    if not matches:
        available = ", ".join(sorted(aliases.keys())) or "(ninguna)"
        print(f'RECORD_ERROR: no existe la conexión "{alias}". Disponibles: {available}', file=sys.stderr)
        sys.exit(4)
    if len(matches) > 1:
        print(f'RECORD_ERROR: "{alias}" es ambiguo ({len(matches)} registros coinciden)', file=sys.stderr)
        sys.exit(4)

    from keepercommander import api

    try:
        record_obj = api.get_record(params, matches[0])
        if record_obj is None:
            raise ValueError("record not found")
    except Exception as exc:
        print(f"RECORD_ERROR: {type(exc).__name__}", file=sys.stderr)
        sys.exit(3)

    result = {
        "host": get_field(record_obj, "host"),
        "client": get_field(record_obj, "client"),
        "user": getattr(record_obj, "login", None) or get_field(record_obj, "login"),
        "password": getattr(record_obj, "password", None) or get_field(record_obj, "password"),
    }

    missing = [k for k, v in result.items() if not v]
    if missing:
        print(f"RECORD_ERROR: faltan campos en el registro de Keeper: {', '.join(missing)}", file=sys.stderr)
        sys.exit(3)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
