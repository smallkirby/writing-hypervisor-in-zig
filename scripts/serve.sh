#!/usr/bin/bash

set -eu

lang=${1:?"Usage $0 <language> <destination>"}
dest=${2:?"Usage $0 <language> <destination>"}

default_lang="ja"

if [ "$lang" = "$default_lang" ]; then
    echo "Building default($default_lang) version..."
else
    echo "Building $lang version..."

    export MDBOOK_BOOK__LANGUAGE=$lang
    export MDBOOK_OUTPUT__HTML__SITE_URL=/$lang
    export MDBOOK_OUTPUT__HTML__REDIRECT='{}'
fi

mdbook serve -d "$dest" --open
