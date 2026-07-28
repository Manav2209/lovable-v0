import React, { useState, useEffect } from 'react';
import { GoogleLogin } from 'react-google-login';

const GoogleAuth = () => {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userData, setUserData] = useState({});

  const responseGoogle = (response) => {
    if (response.tokenId) {
      setIsLoggedIn(true);
      setUserData(response.profileObj);
    }
  };

  return (
    <div>
      <GoogleLogin
        clientId='YOUR_CLIENT_ID'
        buttonText='Login with Google'
        onSuccess={responseGoogle}
        onFailure={responseGoogle}
        cookiePolicy={'single_host_origin'}
      />
      {isLoggedIn && (
        <div>
          <h2>Welcome, {userData.name}!</h2>
          <p>Email: {userData.email}</p>
        </div>
      )}
    </div>
  );
};

export default GoogleAuth;