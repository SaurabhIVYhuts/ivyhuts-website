import React from 'react';
import { Link } from 'react-router-dom';

function CityCard({ city }) {
  const href = `/properties?city=${encodeURIComponent(city.name)}`;

  return (
    <Link to={href} className="city-card">
      <div className="city-card-image">
        <img src={city.image} alt={city.name} />
        <span className="city-card-flag" aria-hidden="true">
          {city.flag}
        </span>
      </div>
      <div className="city-card-body">
        <div className="city-card-topline">
          <div>
            <h3>{city.name}</h3>
            <p>{city.country}</p>
          </div>
          <span className="city-card-chip">{city.flag}</span>
        </div>
        <div className="city-card-meta">
          {city.price != null && city.currency ? (
            <span>Starting from {city.currency}{city.price}/week</span>
          ) : (
            <span className="city-card-meta-loading">Loading availability…</span>
          )}
          {city.properties != null && <span>{city.properties} properties</span>}
        </div>
        <p className="city-card-description">{city.description}</p>
      </div>
    </Link>
  );
}

export default CityCard;
