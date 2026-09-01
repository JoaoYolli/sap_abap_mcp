#!/usr/bin/env python3
"""
Login interactivo de Keeper Commander para sap-mcp.

Ejecutar SIEMPRE manualmente en una terminal normal, nunca a traves del
chat de Claude Code (pide la contrasena maestra y el 2FA de Keeper por
consola/push, y esos datos no deben pasar nunca por la conversacion con
la IA):

    py keeper/login.py [horas_de_sesion]

Pide email + contrasena maestra + 2FA de forma interactiva, activa el
login persistente de ese dispositivo y le pone una expiracion de sesion
(por defecto 10 horas, ver "horas_de_sesion"). Guarda la configuracion
del dispositivo en ~/.sap-mcp/keeper-commander-config.json.

fetch_secret.py reutiliza esa sesion sin volver a pedir credenciales
hasta que expire; cuando expire, hay que volver a correr este script.
"""
import os
import sys

CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".sap-mcp", "keeper-commander-config.json")


def main():
    hours = float(sys.argv[1]) if len(sys.argv) > 1 else 10

    from keepercommander.params import KeeperParams
    from keepercommander import api, cli

    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)

    params = KeeperParams()
    params.config_filename = CONFIG_PATH
    params.user = input("Email de Keeper: ").strip()

    api.login(params)  # pide contrasena maestra + 2FA de forma interactiva
    api.sync_down(params)

    if not getattr(params, "session_token", None):
        print("Login fallido: no se obtuvo sesion.", file=sys.stderr)
        sys.exit(1)

    # Registra este dispositivo, activa login persistente y fija cuanto
    # dura esa sesion antes de exigir login manual otra vez.
    cli.do_command(params, "this-device register")
    cli.do_command(params, "this-device persistent-login on")
    cli.do_command(params, f"this-device timeout {hours:g}h")

    print(f"OK: sesion de Keeper iniciada y guardada en {CONFIG_PATH} (expira en {hours:g}h).")


if __name__ == "__main__":
    main()
