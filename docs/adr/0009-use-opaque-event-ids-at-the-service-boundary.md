# Use opaque event IDs at the service boundary

SukimaCanvas will expose participants only to stable, unguessable event Public IDs and will keep WBO board identifiers internal. Legacy `/boards/*`, random-board, raw SVG, preview, and download routes are not service entry points, which prevents direct routing from bypassing event admission, capacity, lifecycle, and archive policies.
