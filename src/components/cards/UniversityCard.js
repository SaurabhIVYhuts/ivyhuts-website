import React from 'react';
import { Link } from 'react-router-dom';

function UniversityCard({ university }) {
  return (
    <div className="university-card">
      <div className="university-logo" aria-hidden="true">
        {university.logo}
      </div>
      <div className="university-info">
        <h3>{university.name}</h3>
        <p>{university.city}</p>
        <span>Avg. rent {university.currency}{university.rent}/week</span>
      </div>
      <Link to="/find-rooms" className="university-card-link">
        View Accommodation
      </Link>
    </div>
  );
}

export default UniversityCard;
