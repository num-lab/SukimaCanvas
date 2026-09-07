# Retain a platform layer around the WBO engine

SukimaCanvas will treat WBO as the real-time board engine and put account, organizer, reservation, event, access, archive, and integration concerns in a separate platform layer. Core WBO changes will remain narrow and covered by tests so that security fixes and selected upstream changes can be adopted without service-specific business logic spreading through the drawing engine.
