# dmgbuild settings for Resizer.dmg — used by macos/make-dmg.sh (values come in via -D).
import os

app = defines["app"]
background = defines["background"]

format = "UDZO"
files = [app]
symlinks = {"Applications": "/Applications"}
icon = os.path.join(app, "Contents", "Resources", "AppIcon.icns")   # volume icon

# Window matches background.tiff (640x420); icons sit on the arrow drawn in background.html.
window_rect = ((200, 140), (640, 420))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
icon_size = 128
text_size = 13
icon_locations = {
    "Resizer.app": (170, 205),
    "Applications": (470, 205),
}
