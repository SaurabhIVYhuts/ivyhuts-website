import React from 'react';
import { Link } from 'react-router-dom';

function CountryCard({ country }) {
  return (
    <div className="country-card">
      <div className="country-card-flag" aria-hidden="true">
        {country.flag}
      </div>
      <div className="country-card-content">
        <h3>{country.name}</h3>
        <p>{country.cities} cities</p>
      </div>
      <Link to="/find-rooms" className="country-card-link">
        Explore
      </Link>
    </div>
  );
}

export default CountryCard;
