import React from 'react';
import { Link } from 'react-router-dom';
import { countryFullName, countryIsoCode } from '../../data/destinations';

function CityCard({ city }) {
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
          <img src={city.image} alt={`${city.name}, ${countryName}`} loading="lazy" />
          <div className="city-card-overlay">
            <h3>{city.name}</h3>
            <p>
              <span className="city-card-code">{countryIsoCode(city.country)}</span> {countryName}
            </p>
          </div>
        </div>
      </Link>
    </li>
  );
}

export default CityCard;
