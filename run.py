"""Entry point — loads .env then starts the server."""
import os
from pathlib import Path

# Load .env if present
env_file = Path(__file__).parent / '.env'
if env_file.exists():
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())

import uvicorn

if __name__ == '__main__':
    host = os.environ.get('HOST', '0.0.0.0')
    port = int(os.environ.get('PORT', 7842))
    uvicorn.run('app.main:app', host=host, port=port, reload=False, log_level='info')
