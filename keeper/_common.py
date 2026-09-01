"""
Helpers compartidos por list_connections.py y fetch_secret.py.

Descubre las conexiones SAP explorando la carpeta "Claude Connections" del
vault de Keeper (y sus subcarpetas, una por empresa/servidor). No hay
ningún archivo local de mapeo alias->recordUid: los alias se calculan cada
vez a partir de la estructura real de carpetas + el título de cada
registro, así que dar de alta una conexión nueva es solo crear el registro
en Keeper (en la carpeta correcta) y no toca ningún fichero de este repo
ni de la máquina local.
"""
import os

CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".sap-mcp", "keeper-commander-config.json")
ROOT_FOLDER_NAME = "Claude Connections"
LOGIN_REQUIRED_MARKER = "KEEPER_LOGIN_REQUIRED"


class LoginRequiredError(Exception):
    pass


def load_authenticated_params():
    """Carga la sesión persistente creada por login.py. Nunca pide nada por
    consola: si hace falta un prompt (contraseña/2FA), Node ya cerró stdin
    al lanzar este script, así que el intento de leerlo revienta al
    instante (EOFError) en vez de quedarse colgado — se traduce aquí en
    LoginRequiredError."""
    if not os.path.exists(CONFIG_PATH):
        raise LoginRequiredError()

    from keepercommander.__main__ import get_params_from_config
    from keepercommander import api

    params = get_params_from_config(CONFIG_PATH)

    try:
        api.login(params)
        api.sync_down(params)
    except Exception:
        raise LoginRequiredError()

    if not getattr(params, "session_token", None):
        raise LoginRequiredError()

    return params


def _field_label(name):
    # El vault moderno guarda los custom fields como "<tipo>:<etiqueta>"
    # (ej. "text:host"), no la etiqueta a secas. Nos quedamos con lo de
    # después del primer ":" si lo hay.
    return name.split(":", 1)[1] if ":" in name else name


def get_field(record_obj, name):
    try:
        value = record_obj.get(name)
        if value:
            return value
    except Exception:
        pass

    data = record_obj.to_dictionary()
    custom = data.get("custom_fields") or data.get("custom") or {}
    if isinstance(custom, dict):
        for key, value in custom.items():
            if _field_label(key).lower() == name.lower():
                return value
    elif isinstance(custom, list):
        for entry in custom:
            entry_name = str(entry.get("name", ""))
            if _field_label(entry_name).lower() == name.lower():
                return entry.get("value")
    return None


def discover_connections(params):
    """Devuelve {alias: [record_uid, ...]} explorando ROOT_FOLDER_NAME y
    todas sus subcarpetas. Un alias sin subcarpeta es solo el título del
    registro; dentro de una subcarpeta es "<subcarpeta>/<título>" (rutas
    completas si hay varios niveles de anidamiento).

    Nunca sube más allá de ROOT_FOLDER_NAME ni toca otras carpetas del
    vault: si esa carpeta no existe, falla en vez de listar todo el vault.
    """
    from keepercommander import subfolder, api
    from keepercommander.commands.base import FolderMixin

    root_uids = {u for u in subfolder.get_folder_uids(params, ROOT_FOLDER_NAME) if u}
    if not root_uids:
        raise RuntimeError(
            f'No se encontró la carpeta "{ROOT_FOLDER_NAME}" en el nivel superior del vault de Keeper.'
        )

    recs_by_folder = {}
    for root_uid in root_uids:
        def on_folder(f, _acc=recs_by_folder):
            f_uid = f.uid or ""
            if f_uid:
                _acc[f_uid] = set(params.subfolder_record_cache.get(f_uid, set()))

        FolderMixin.traverse_folder_tree(params, root_uid, on_folder)

    aliases = {}
    for folder_uid, record_uids in recs_by_folder.items():
        folder_path = subfolder.get_folder_path(params, folder_uid, delimiter="/")
        if folder_path == ROOT_FOLDER_NAME:
            prefix = ""
        elif folder_path.startswith(ROOT_FOLDER_NAME + "/"):
            prefix = folder_path[len(ROOT_FOLDER_NAME) + 1:]
        else:
            continue  # fuera del árbol esperado; no debería pasar, se ignora por seguridad

        for record_uid in record_uids:
            try:
                record_obj = api.get_record(params, record_uid)
            except Exception:
                continue
            if not record_obj or not record_obj.title:
                continue
            alias = f"{prefix}/{record_obj.title}" if prefix else record_obj.title
            aliases.setdefault(alias, []).append(record_uid)

    return aliases
