import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export default function LearnerEngine() {
  const navigate = useNavigate();
  useEffect(() => { navigate('/autopilot', { replace: true }); }, [navigate]);
  return null;
}