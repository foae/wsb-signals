"""Enable `python -m wsb_signals ...` regardless of console-script install."""
from .cli import main

if __name__ == "__main__":
    main()
