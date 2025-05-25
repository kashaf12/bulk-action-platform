import { Router } from 'express';

const router = Router();

router.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested API endpoint does not exist.',
  });
});

export default router;
