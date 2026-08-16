import React from 'react';
import { Link } from 'react-router-dom';
import { countryFullName, countryIsoCode } from '../../data/destinations';

function CityCard({ city, compact = false }) {
  const href = `/properties?city=${encodeURIComponent(city.name)}`;
  const countryName = countryFullName(city.country);

  return (
    <li className="city-card-item">
      <Link
        to={href}
        className="city-card"
        aria-label={`View student accommodation in ${city.name}, ${countryName}`}
      >
        <div className="city-card-image">
          {city.image && (
            <img
              src={city.image}
              alt={`${city.name}, ${countryName}`}
              loading="lazy"
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />
          )}
          <div className="city-card-overlay">
            <h3>{city.name}</h3>
            <p>
              <span className="city-card-code">{countryIsoCode(city.country)}</span> {countryName}
            </p>
          </div>
        </div>
        {!compact && (
          <div className="city-card-body">
            <div className="city-card-meta">
              {city.price != null && city.currency ? (
                <span>Starting from {city.currency}{city.price}/week</span>
              ) : (
                <span className="city-card-meta-loading">Availability on request</span>
              )}
              {city.properties != null && <span>{city.properties} properties</span>}
            </div>
            <p className="city-card-description">{city.description}</p>
          </div>
        )}
      </Link>
    </li>
  );
}

export default CityCard;
