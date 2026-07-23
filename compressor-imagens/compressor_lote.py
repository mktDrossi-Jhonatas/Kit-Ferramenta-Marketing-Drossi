#!/usr/bin/env python3
"""Compressor de imagens em lote — mesmas regras do ImagePress (index.html deste diretório).

Uso:
    python compressor_lote.py "CAMINHO\\DA\\PASTA"
    python compressor_lote.py "CAMINHO\\DA\\PASTA" --dry-run
    python compressor_lote.py "CAMINHO\\DA\\PASTA" --no-backup

Requer: pip install pillow
"""

import argparse
import datetime
import os
import shutil
import sys

from PIL import Image, ImageOps

MAX_SIZE_BYTES = 1024 * 1024
MAX_DIM = 2500
TARGET_MAX_DIM = 2400
MIN_FLOOR_DIM = 1800
TARGET_SIZE_BYTES = 1000 * 1024
MIN_TARGET_BYTES = 750 * 1024
QUALITY_START = 92
QUALITY_STEP = 4
QUALITY_FLOOR = 60
EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def calc_dimensions(w, h):
    m = max(w, h)
    if m <= MAX_DIM:
        return w, h
    scale = TARGET_MAX_DIM / m
    nw, nh = round(w * scale), round(h * scale)
    sm = max(nw, nh)
    if sm < MIN_FLOOR_DIM:
        up = MIN_FLOOR_DIM / sm
        nw, nh = round(nw * up), round(nh * up)
    return nw, nh


def flatten_to_rgb(im):
    if im.mode in ("RGBA", "LA", "P"):
        im2 = im.convert("RGBA")
        bg = Image.new("RGB", im2.size, (0, 0, 0))
        bg.paste(im2, mask=im2.split()[-1])
        return bg
    return im.convert("RGB")


def process_file(path, root, backup_root, dry_run):
    ext = os.path.splitext(path)[1].lower()
    orig_size = os.path.getsize(path)
    with Image.open(path) as im0:
        im0 = ImageOps.exif_transpose(im0)
        w, h = im0.size
        needs_dim = max(w, h) > MAX_DIM
        needs_size = orig_size > MAX_SIZE_BYTES
        if not needs_dim and not needs_size:
            return None  # dentro dos limites, comportamento "sem alteração"

        keep_png = ext == ".png" and not needs_size
        tw, th = calc_dimensions(w, h)

        if dry_run:
            return (path, path if keep_png else os.path.splitext(path)[0] + ".jpg", orig_size, None)

        if keep_png:
            im = im0.convert("RGBA") if im0.mode in ("RGBA", "LA", "P") else im0.convert("RGB")
        else:
            im = flatten_to_rgb(im0)
        im = im.resize((tw, th), Image.Resampling.LANCZOS)

        if backup_root:
            rel = os.path.relpath(path, root)
            backup_path = os.path.join(backup_root, rel)
            os.makedirs(os.path.dirname(backup_path), exist_ok=True)
            shutil.copy2(path, backup_path)

        if keep_png:
            im.save(path, "PNG", optimize=True)
            final_path = path
        else:
            quality = QUALITY_START
            final_path = os.path.splitext(path)[0] + ".jpg"
            im.save(final_path, "JPEG", quality=quality, optimize=True)
            if needs_size:
                while os.path.getsize(final_path) > TARGET_SIZE_BYTES and quality > QUALITY_FLOOR:
                    quality = max(quality - QUALITY_STEP, QUALITY_FLOOR)
                    im.save(final_path, "JPEG", quality=quality, optimize=True)
                    if os.path.getsize(final_path) <= MIN_TARGET_BYTES:
                        break
            if final_path != path:
                os.remove(path)

    new_size = os.path.getsize(final_path)
    return (path, final_path, orig_size, new_size)


def iter_images(root):
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            if os.path.splitext(fn)[1].lower() in EXTS:
                yield os.path.join(dirpath, fn)


def main():
    parser = argparse.ArgumentParser(description="Comprime em lote imagens grandes (JPG/PNG/WEBP), seguindo as mesmas regras do ImagePress.")
    parser.add_argument("pasta", help="Pasta raiz a processar (percorre subpastas automaticamente)")
    parser.add_argument("--dry-run", action="store_true", help="Apenas mostra o que seria comprimido, sem alterar nenhum arquivo")
    parser.add_argument("--no-backup", action="store_true", help="Não faz backup dos originais antes de sobrescrever (não recomendado)")
    args = parser.parse_args()

    root = os.path.abspath(args.pasta)
    if not os.path.isdir(root):
        print(f"Pasta não encontrada: {root}", file=sys.stderr)
        sys.exit(1)

    backup_root = None
    if not args.dry_run and not args.no_backup:
        stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_root = os.path.join(root, f"_backup_originais_{stamp}")

    processed = []
    errors = []
    scanned = 0

    for path in iter_images(root):
        if backup_root and path.startswith(backup_root):
            continue
        scanned += 1
        try:
            result = process_file(path, root, backup_root, args.dry_run)
            if result:
                processed.append(result)
                _, final_p, o, n = result
                label = os.path.relpath(final_p, root)
                if args.dry_run:
                    print(f"[SERIA COMPRIMIDO] {label}  ({o/1024:.0f} KB)")
                else:
                    pct = round((o - n) / o * 100) if o else 0
                    print(f"OK  {label}  {o/1024:.0f}KB -> {n/1024:.0f}KB (-{pct}%)")
        except Exception as e:
            errors.append((path, str(e)))
            print(f"ERR {path}: {e}", file=sys.stderr)

    print("\n=== RESUMO ===")
    print(f"Arquivos escaneados: {scanned}")
    print(f"{'Seriam comprimidos' if args.dry_run else 'Comprimidos'}: {len(processed)}")
    print(f"Erros: {len(errors)}")
    if processed and not args.dry_run:
        total_o = sum(r[2] for r in processed)
        total_n = sum(r[3] for r in processed)
        saved = total_o - total_n
        print(f"Tamanho original total (dos comprimidos): {total_o/1024/1024:.1f} MB")
        print(f"Tamanho novo total: {total_n/1024/1024:.1f} MB")
        print(f"Economia: {saved/1024/1024:.1f} MB ({saved/total_o*100:.0f}%)" if total_o else "")
    if backup_root and processed:
        print(f"Backup salvo em: {backup_root}")
    if errors:
        print("\nArquivos com erro:")
        for p, e in errors:
            print(f"  {p}: {e}")


if __name__ == "__main__":
    main()
