# SukimaCanvas Service

SukimaCanvas is a hosted collaborative whiteboard service for scheduled events. It coordinates organizers, participants, capacity-backed board sessions, and archived outcomes.

## Language

### Parties and roles

**Organizer**:
A person or organization that reserves and governs events. An organizer may have multiple organizer members.
_Avoid_: Renter, lessee, customer account

**Organizer Member**:
A registered user authorized to act on behalf of an organizer.
_Avoid_: Tenant user, staff account

**Organizer Owner**:
An organizer member accountable for the organizer itself, including its membership and external access.
_Avoid_: Super admin, tenant root

**Organizer Admin**:
An organizer member authorized to manage the organizer's events, reservations, archives, and publication choices.
_Avoid_: Board owner, activity manager

**Event Moderator**:
An organizer member authorized to moderate one event without authority over the organizer or other events.
_Avoid_: Temporary moderator, board admin

**Platform Operator**:
A service representative authorized to approve reservations, govern platform capacity, and handle platform-level incidents.
_Avoid_: Site admin, superuser

**Participant**:
A registered user who joins an event to view or contribute to its board session.
_Avoid_: Anonymous user, visitor

**Account**:
A verified service identity used to authenticate a person and associate their participation across events.
_Avoid_: Browser identity, email address, user secret

**Event Membership**:
The durable authorization linking one participant to one event for the duration of its board session.
_Avoid_: Login session, invite record, board permission

**Organizer Application**:
A registered user's request to establish an organizer, subject to platform approval.
_Avoid_: Self-service tenant, signup, organization request

**Organizer Invitation**:
An expiring offer from an Organizer Owner for an account to become an organizer member, effective only after acceptance.
_Avoid_: Public organization join, implicit membership, admin signup

### Events and access

**Event**:
The participant-facing occasion through which people discover and enter a scheduled collaboration.
_Avoid_: Activity, meeting, board

**Public ID**:
A stable, unguessable identifier used in an event's service URL without exposing its internal board identifier.
_Avoid_: Event slug, board name, display title

**Event Visibility**:
The rule that determines whether an event is discoverable on the service homepage or reachable only through a direct link. Visibility does not grant entry.
_Avoid_: Access level, board privacy

**Event Lock**:
A temporary restriction that prevents new entrants from joining an event without removing existing participants.
_Avoid_: Event ban, code rotation, board closure

**Board Session**:
The time-bounded collaborative whiteboard belonging to an event. A closed board session is immutable.
_Avoid_: Board instance, room, canvas

**Preparation Window**:
The fifteen-minute period before an event opens in which authorized organizer members may prepare its board session while participants cannot enter.
_Avoid_: Early public access, pre-event session, draft board

**Participant Seat**:
One unit of an event's declared participant capacity, held by a unique participant rather than by that participant's devices or browser tabs.
_Avoid_: Socket slot, browser seat, connection quota

**Capacity Allocation**:
The Board Session and Participant Seat capacity committed to a confirmed reservation throughout its capacity window.
_Avoid_: Overbooking, live connection count, unused quota

**Reservation**:
An organizer's request for a board session and its capacity window. A confirmed reservation guarantees the reserved capacity.
_Avoid_: Booking request, rental

**Reservation Change Request**:
An organizer's request to alter or cancel a submitted or confirmed reservation, subject to platform approval when it affects capacity.
_Avoid_: Direct edit, schedule override, booking patch

**Access Code**:
A credential that proves eligibility to enter an event but does not establish a participant's identity.
_Avoid_: Password, user token

**Entry Grant**:
A short-lived, single-use authorization that admits an authenticated participant to one board session.
_Avoid_: Entry link, partner pass, access code

**Participant Identifier**:
An opaque, event-scoped identifier that may represent a participant in a published canvas without revealing account information.
_Avoid_: Username, account ID, real name

**Presentation Choice**:
A participant's event-wide decision at entry whether a published canvas may display that participant's identifier beside their attributed board items. Choosing anonymity removes that identifier from all of the participant's published items without changing private attribution.
_Avoid_: Public profile, consent flag, anonymity mode

**Event Ban**:
A time-bounded or event-long exclusion that removes a participant from one event and prevents re-entry.
_Avoid_: Edit ban, IP ban, platform ban

**API Credential**:
A revocable, organizer-scoped secret that authorizes an organizer's server to use the integration API.
_Avoid_: Shared service secret, browser key, user password

**Webhook Subscription**:
An organizer's authenticated request to receive signed, at-least-once lifecycle notifications from the service.
_Avoid_: Callback URL, polling hook, event listener

**Lifecycle Notice**:
A service notification about a reservation, event, archive, or integration delivery state sent to the intended organizer member, event participant holding a membership, or webhook subscriber.
_Avoid_: Marketing email, chat message, generic alert

**External Participant Reference**:
An optional opaque value supplied by an organizer's server to correlate an Entry Grant with that organizer's own records.
_Avoid_: External login, user identity, customer profile

**Participant Report**:
A participant's allegation of harmful conduct by an online participant within one event, retained for moderator and platform review.
_Avoid_: Global complaint, automatic ban, content scan

### Content and outcomes

**Board Item**:
A discrete piece of content contributed to a board session, such as a pencil stroke, shape, text block, or image.
_Avoid_: Stroke, contribution, canvas object

**Item Attribution**:
The immutable relationship between a board item and the participant who created it.
_Avoid_: Last editor, current owner, contributor label

**Change Audit**:
The retained history of participant actions that modify or remove board items during a board session, available to authorized roles for the archive retention period.
_Avoid_: Undo history, activity feed, revision label

**Board Archive**:
The immutable authoritative outcome captured when a board session closes.
_Avoid_: Saved board, final canvas, download

**Historical Archive**:
A private Board Archive explicitly imported from legacy WBO content whose Board Items have unknown attribution and no Change Audit.
_Avoid_: Migrated live board, audited archive, automatic import

**Published Canvas**:
A sanitized, read-only presentation derived from a board archive for an allowed audience.
_Avoid_: Public archive, source board, preview

**Image Export**:
A flattened image derived from a board archive without attribution or internal metadata, available only to an authorized organizer member.
_Avoid_: Archive download, editable export, source board

**Export Job**:
An asynchronous request to produce an image export from a board archive.
_Avoid_: Download request, render task, image conversion

**Publication Policy**:
An organizer's rules for who may view a published canvas and whether participant attribution is shown.
_Avoid_: Board permissions, download setting, privacy flag

**Publication Audience**:
The allowed viewers of a published canvas: only the organizer, event participants, or holders of an unguessable public link.
_Avoid_: Search visibility, event discovery, access code

**Brand Asset**:
A validated organizer logo or event cover image displayed by the service.
_Avoid_: Arbitrary upload, white-label theme, custom HTML

**Service Region**:
The geographic and legal boundary in which SukimaCanvas stores and operates service data for a release. The first release operates in mainland China.
_Avoid_: Global launch, user locale, deployment zone
