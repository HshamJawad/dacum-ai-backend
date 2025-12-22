const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireParticipantAuth, requireFacilitatorAuth } = require('../middleware/auth');
const { voteSchema, batchVoteSchema } = require('../validators/schemas');

// Cast single vote
// CRITICAL: Validates taskKey against database
router.post('/cast', requireParticipantAuth, async (req, res) => {
  try {
    const { taskKey, importanceRating, frequencyRating, difficultyRating } = req.body;
    
    // CRITICAL: Validate taskKey exists in database
    const taskCheck = await db.query(
      'SELECT id FROM tasks WHERE task_key = $1',
      [taskKey]
    );
    
    if (taskCheck.rows.length === 0) {
      return res.status(400).json({
        error: 'Validation failed',
        details: [{
          field: 'taskKey',
          message: 'Invalid'
        }]
      });
    }
    
    // Validate at least one rating is provided
    if (importanceRating === undefined && frequencyRating === undefined && difficultyRating === undefined) {
      return res.status(400).json({
        error: 'Validation failed',
        details: [{
          field: 'ratings',
          message: 'At least one rating must be provided'
        }]
      });
    }
    
    // Insert or update vote
    const result = await db.query(`
      INSERT INTO task_votes (
        participant_id, 
        task_key, 
        importance_rating, 
        frequency_rating, 
        difficulty_rating,
        voted_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (participant_id, task_key) 
      DO UPDATE SET
        importance_rating = COALESCE(EXCLUDED.importance_rating, task_votes.importance_rating),
        frequency_rating = COALESCE(EXCLUDED.frequency_rating, task_votes.frequency_rating),
        difficulty_rating = COALESCE(EXCLUDED.difficulty_rating, task_votes.difficulty_rating),
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [
      req.participantId,
      taskKey,
      importanceRating !== undefined ? importanceRating : null,
      frequencyRating !== undefined ? frequencyRating : null,
      difficultyRating !== undefined ? difficultyRating : null
    ]);
    
    const vote = result.rows[0];
    
    res.json({
      success: true,
      message: 'Vote recorded successfully',
      vote: {
        id: vote.id,
        taskKey: vote.task_key,
        importanceRating: vote.importance_rating,
        frequencyRating: vote.frequency_rating,
        difficultyRating: vote.difficulty_rating,
        votedAt: vote.voted_at,
        updatedAt: vote.updated_at
      }
    });
    
  } catch (error) {
    console.error('Vote cast error:', error);
    res.status(500).json({ error: 'Failed to cast vote' });
  }
});

// Batch vote
router.post('/batch', requireParticipantAuth, async (req, res) => {
  try {
    const { votes } = req.body;
    
    if (!votes || !Array.isArray(votes) || votes.length === 0) {
      return res.status(400).json({ error: 'Votes array required' });
    }
    
    if (votes.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 votes per batch' });
    }
    
    // Begin transaction
    await db.query('BEGIN');
    
    try {
      let successCount = 0;
      
      for (const vote of votes) {
        const { taskKey, importanceRating, frequencyRating, difficultyRating } = vote;
        
        // Validate taskKey exists
        const taskCheck = await db.query(
          'SELECT id FROM tasks WHERE task_key = $1',
          [taskKey]
        );
        
        if (taskCheck.rows.length === 0) {
          continue; // Skip invalid taskKeys
        }
        
        // Insert or update
        await db.query(`
          INSERT INTO task_votes (
            participant_id, 
            task_key, 
            importance_rating, 
            frequency_rating, 
            difficulty_rating,
            voted_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT (participant_id, task_key) 
          DO UPDATE SET
            importance_rating = COALESCE(EXCLUDED.importance_rating, task_votes.importance_rating),
            frequency_rating = COALESCE(EXCLUDED.frequency_rating, task_votes.frequency_rating),
            difficulty_rating = COALESCE(EXCLUDED.difficulty_rating, task_votes.difficulty_rating),
            updated_at = CURRENT_TIMESTAMP
        `, [
          req.participantId,
          taskKey,
          importanceRating !== undefined ? importanceRating : null,
          frequencyRating !== undefined ? frequencyRating : null,
          difficultyRating !== undefined ? difficultyRating : null
        ]);
        
        successCount++;
      }
      
      await db.query('COMMIT');
      
      res.json({
        success: true,
        message: `${successCount} votes recorded successfully`,
        count: successCount
      });
      
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    
  } catch (error) {
    console.error('Batch vote error:', error);
    res.status(500).json({ error: 'Failed to process batch votes' });
  }
});

// Get my votes
router.get('/my', requireParticipantAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM task_votes 
       WHERE participant_id = $1 
       ORDER BY updated_at DESC`,
      [req.participantId]
    );
    
    res.json({
      success: true,
      votes: result.rows.map(vote => ({
        id: vote.id,
        taskKey: vote.task_key,
        importanceRating: vote.importance_rating,
        frequencyRating: vote.frequency_rating,
        difficultyRating: vote.difficulty_rating,
        votedAt: vote.voted_at,
        updatedAt: vote.updated_at
      })),
      count: result.rows.length
    });
    
  } catch (error) {
    console.error('Get my votes error:', error);
    res.status(500).json({ error: 'Failed to get votes' });
  }
});

// Get aggregated results (for polling)
// Can be called by participants or facilitators
router.get('/aggregated', async (req, res) => {
  try {
    let workshopId;
    
    // Check if participant token provided
    if (req.headers['x-participant-token']) {
      const participantResult = await db.query(
        `SELECT p.workshop_id 
         FROM participants p 
         WHERE p.participant_token = $1 AND p.status = 'active'`,
        [req.headers['x-participant-token']]
      );
      
      if (participantResult.rows.length > 0) {
        workshopId = participantResult.rows[0].workshop_id;
      }
    }
    
    // Check if facilitator token provided
    if (!workshopId && req.headers['x-facilitator-token']) {
      const workshopResult = await db.query(
        'SELECT id FROM workshops WHERE facilitator_token = $1',
        [req.headers['x-facilitator-token']]
      );
      
      if (workshopResult.rows.length > 0) {
        workshopId = workshopResult.rows[0].id;
      }
    }
    
    if (!workshopId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Get aggregations using view
    const result = await db.query(`
      SELECT 
        task_key,
        task_title,
        duty_id,
        duty_title,
        vote_count,
        avg_importance,
        avg_frequency,
        avg_difficulty,
        last_updated
      FROM task_vote_aggregations
      WHERE workshop_id = $1
      ORDER BY duty_id, task_key
    `, [workshopId]);
    
    // Get participant count
    const participantCount = await db.query(
      `SELECT COUNT(DISTINCT v.participant_id) 
       FROM task_votes v 
       JOIN tasks t ON t.task_key = v.task_key 
       JOIN duties d ON d.id = t.duty_id 
       WHERE d.workshop_id = $1`,
      [workshopId]
    );
    
    const totalParticipants = parseInt(participantCount.rows[0].count) || 0;
    
    // Get workshop info for priority formula
    const workshopInfo = await db.query(
      'SELECT priority_formula FROM workshops WHERE id = $1',
      [workshopId]
    );
    
    const priorityFormula = workshopInfo.rows[0]?.priority_formula || 'if';
    
    res.json({
      success: true,
      aggregations: result.rows.map(row => {
        const avgImportance = parseFloat(row.avg_importance) || 0;
        const avgFrequency = parseFloat(row.avg_frequency) || 0;
        const avgDifficulty = parseFloat(row.avg_difficulty) || 0;
        
        // Calculate priority index based on formula
        let priorityIndex;
        if (priorityFormula === 'ifd') {
          priorityIndex = avgImportance + avgFrequency + avgDifficulty;
        } else {
          priorityIndex = avgImportance + avgFrequency;
        }
        
        return {
          taskKey: row.task_key,
          dutyId: row.duty_id,
          dutyTitle: row.duty_title,
          taskTitle: row.task_title,
          avgImportance: avgImportance,
          avgFrequency: avgFrequency,
          avgDifficulty: avgDifficulty,
          priorityIndex: priorityIndex,
          participantCount: totalParticipants,
          voteCount: parseInt(row.vote_count) || 0,
          lastUpdated: row.last_updated
        };
      }),
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Aggregation error:', error);
    res.status(500).json({ error: 'Failed to get aggregated results' });
  }
});

// Get workshop results by workshop code (public/facilitator)
router.get('/workshop/:workshopCode/aggregated', async (req, res) => {
  const { workshopCode } = req.params;
  
  try {
    // Get workshop
    const workshop = await db.query(
      'SELECT id, priority_formula FROM workshops WHERE workshop_code = $1',
      [workshopCode]
    );
    
    if (workshop.rows.length === 0) {
      return res.status(404).json({ error: 'Workshop not found' });
    }
    
    const workshopId = workshop.rows[0].id;
    const priorityFormula = workshop.rows[0].priority_formula || 'if';
    
    // Get aggregations
    const result = await db.query(`
      SELECT 
        task_key,
        task_title,
        duty_id,
        duty_title,
        vote_count,
        avg_importance,
        avg_frequency,
        avg_difficulty,
        last_updated
      FROM task_vote_aggregations
      WHERE workshop_id = $1
      ORDER BY duty_id, task_key
    `, [workshopId]);
    
    // Get participant count
    const participantCount = await db.query(
      `SELECT COUNT(DISTINCT v.participant_id) 
       FROM task_votes v 
       JOIN tasks t ON t.task_key = v.task_key 
       JOIN duties d ON d.id = t.duty_id 
       WHERE d.workshop_id = $1`,
      [workshopId]
    );
    
    const totalParticipants = parseInt(participantCount.rows[0].count) || 0;
    
    res.json({
      success: true,
      aggregations: result.rows.map(row => {
        const avgImportance = parseFloat(row.avg_importance) || 0;
        const avgFrequency = parseFloat(row.avg_frequency) || 0;
        const avgDifficulty = parseFloat(row.avg_difficulty) || 0;
        
        let priorityIndex;
        if (priorityFormula === 'ifd') {
          priorityIndex = avgImportance + avgFrequency + avgDifficulty;
        } else {
          priorityIndex = avgImportance + avgFrequency;
        }
        
        return {
          taskKey: row.task_key,
          dutyId: row.duty_id,
          dutyTitle: row.duty_title,
          taskTitle: row.task_title,
          avgImportance: avgImportance,
          avgFrequency: avgFrequency,
          avgDifficulty: avgDifficulty,
          priorityIndex: priorityIndex,
          participantCount: totalParticipants,
          voteCount: parseInt(row.vote_count) || 0,
          lastUpdated: row.last_updated
        };
      }),
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Workshop aggregation error:', error);
    res.status(500).json({ error: 'Failed to get results' });
  }
});

// Delete vote
router.delete('/my/:taskKey', requireParticipantAuth, async (req, res) => {
  const { taskKey } = req.params;
  
  try {
    const result = await db.query(
      'DELETE FROM task_votes WHERE participant_id = $1 AND task_key = $2 RETURNING *',
      [req.participantId, taskKey]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Vote not found' });
    }
    
    res.json({
      success: true,
      message: 'Vote deleted successfully'
    });
    
  } catch (error) {
    console.error('Delete vote error:', error);
    res.status(500).json({ error: 'Failed to delete vote' });
  }
});

module.exports = router;
