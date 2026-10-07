# Shared Browser input core

This change adds ordered mouse, touch and keyboard input and bounded recovery
after a viewing token expires. It preserves upstream display controls, the
medium capture default, existing frame limits and headless launch behavior.

Gesture channels start from a decoded frame and retain exact controller,
runtime, document and viewport ownership. Navigation, replacement or expiry
releases held input. Unknown physical input outcomes are never replayed.

Frame handoff and emulation restoration stay with input because they determine
which pixels and page receive a gesture. Automatic viewer recovery reattaches
viewing only; it never acquires control or repeats a failed mutation.

Display menus, resolution favorites, capture density, transport caching and
private Xvfb support are prepared as follow-up changes. Physical-phone keyboard
behavior remains a separate device acceptance check.
