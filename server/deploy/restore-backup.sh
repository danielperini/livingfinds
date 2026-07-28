#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "Uso: $0 caminho/do/backup.dump" >&2
  exit 1
fi

echo "ATENÇÃO: restauração destrutiva não é automática."
echo "Ela deve ocorrer somente em janela de manutenção, após interromper gravações."
echo "Backup informado: $1"
echo "Procedimento recomendado: restaure primeiro em outro banco e valide os dados."
exit 2
