import React from 'react';
import { Link } from 'react-router-dom';

function PropertyCard({ property }) {
  return (
    <div className="property-card">
      <div className="property-card-image">
        <img src={property.image} alt={property.name} />
      </div>
      <div className="property-card-body">
        <div className="property-card-heading">
          <div>
            <h3>{property.name}</h3>
            <p>{property.city}</p>
          </div>
          <span className="property-card-rating">★ {property.rating}</span>
        </div>
        <div className="property-card-meta">
          <span>From {property.currency}{property.price}/week</span>
          <span>{property.roomType}</span>
        </div>
        <Link to="/find-rooms" className="property-card-link">
          View Details
        </Link>
      </div>
    </div>
  );
}

export default PropertyCard;
