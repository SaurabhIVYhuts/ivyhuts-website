import React, { useState } from "react";

const TENANCY_PREVIEW = 2;

function TenancyRow({ tenancy, room, onEnquire }) {
  const handleEnquire = () => {
    onEnquire({
      roomId: room.id,
      roomName: room.name,
      tenancyId: tenancy.id,
      duration: tenancy.leaseDuration,
      moveIn: tenancy.availableFrom,
      moveOut: tenancy.availableTo,
      price: tenancy.price,
      currency: tenancy.currency,
    });
  };

  return (
    <div className={`room-tenancy-row${tenancy.available ? "" : " unavailable"}`}>
      <div className="room-tenancy-fields">
        <div className="room-tenancy-field">
          <span className="room-tenancy-label">Duration</span>
          <span className="room-tenancy-value">{tenancy.leaseDuration || "—"}</span>
        </div>
        <div className="room-tenancy-field">
          <span className="room-tenancy-label">Move In</span>
          <span className="room-tenancy-value">{tenancy.availableFrom || "—"}</span>
        </div>
        {tenancy.availableTo && (
          <div className="room-tenancy-field">
            <span className="room-tenancy-label">Move Out</span>
            <span className="room-tenancy-value">{tenancy.availableTo}</span>
          </div>
        )}
      </div>

      <div className="room-tenancy-footer">
        <span className="room-tenancy-price">
          {tenancy.originalPrice && (
            <span className="room-tenancy-original">{tenancy.currency}{tenancy.originalPrice}</span>
          )}
          {tenancy.price !== null ? (
            <>{tenancy.currency}{tenancy.price}<span className="room-tenancy-unit">/week</span></>
          ) : (
            "Price on request"
          )}
        </span>
        {tenancy.available ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={handleEnquire}>Enquire</button>
        ) : (
          <span className="room-tenancy-status">Sold Out</span>
        )}
      </div>
    </div>
  );
}

export default function RoomTypeCard({ room, onEnquire }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [tenanciesExpanded, setTenanciesExpanded] = useState(false);

  const aboutText = room.about.join("\n\n");
  const hasDetails = !!aboutText || room.paymentNotes.length > 0;

  const visibleTenancies = tenanciesExpanded ? room.tenancies : room.tenancies.slice(0, TENANCY_PREVIEW);
  const hiddenCount = room.tenancies.length - TENANCY_PREVIEW;

  return (
    <div className={`room-type-card${room.available ? "" : " room-type-unavailable"}`}>
      <div className="room-type-summary">
        <div className="room-type-image">
          {room.image ? <img src={room.image} alt={room.name} loading="lazy" /> : <div className="room-type-image-empty" />}
        </div>

        <div className="room-type-info">
          <h3 className="room-type-name">{room.name}</h3>

          <div className="room-type-availability-line">
            {room.available ? (
              room.availableFrom && <span className="room-type-available-from">Available from: {room.availableFrom}</span>
            ) : (
              <span className="room-type-soldout-label">Currently sold out</span>
            )}
            {room.price.from !== null && (
              <span className="room-type-from-price">
                From: <strong>{room.price.currency}{room.price.from}{room.price.duration ? `/${room.price.duration}` : ""}</strong>
              </span>
            )}
          </div>

          {(room.metaChips.length > 0 || room.sizeSqm) && (
            <div className="room-type-chips">
              {room.metaChips.map((c) => <span key={c} className="room-type-chip">{c}</span>)}
              {room.sizeSqm ? <span className="room-type-chip">{room.sizeSqm} sqm</span> : null}
            </div>
          )}

          {hasDetails && (
            <button
              type="button"
              className="room-type-details-toggle"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((o) => !o)}
            >
              {detailsOpen ? "View Less Details" : "View More Details"}
              <span aria-hidden="true">{detailsOpen ? " ﹀" : " ›"}</span>
            </button>
          )}
        </div>
      </div>

      {detailsOpen && hasDetails && (
        <div className="room-type-details">
          {aboutText && <p className="room-type-about">{aboutText}</p>}
          {room.paymentNotes.length > 0 && (
            <div className="room-type-payment-notes">
              {room.paymentNotes.map((n) => (
                <span key={n.label} className="room-type-payment-chip" title={n.text}>{n.label}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {visibleTenancies.length > 0 && (
        <div className="room-tenancies">
          {visibleTenancies.map((t) => (
            <TenancyRow key={t.id} tenancy={t} room={room} onEnquire={onEnquire} />
          ))}
          {hiddenCount > 0 && (
            <button
              type="button"
              className="room-tenancy-toggle"
              aria-expanded={tenanciesExpanded}
              onClick={() => setTenanciesExpanded((e) => !e)}
            >
              {tenanciesExpanded ? "View fewer tenancies" : `View more tenancies (${hiddenCount})`}
              <span aria-hidden="true">{tenanciesExpanded ? " ▲" : " ▼"}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}