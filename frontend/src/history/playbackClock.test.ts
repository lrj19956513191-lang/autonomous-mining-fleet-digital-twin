import { expect, test } from 'vitest';
import { createPlaybackClock } from './playbackClock';

test('starts_paused_and_advances_only_while_playing',()=>{
  const clock=createPlaybackClock({start:0,end:130});
  expect(clock.getState()).toEqual({status:'PAUSED',time_seconds:0,rate:1});
  expect(clock.tick(500)).toEqual({status:'PAUSED',time_seconds:0,rate:1});
  clock.play(1000);
  expect(clock.tick(2000)).toEqual({status:'PLAYING',time_seconds:1,rate:1});
  expect(clock.pause(2000)).toEqual({status:'PAUSED',time_seconds:1,rate:1});
  expect(clock.tick(9000)).toEqual({status:'PAUSED',time_seconds:1,rate:1});
});
test.each([0.5,1,2,4] as const)('rate %s advances simulation seconds',rate=>{
  const clock=createPlaybackClock({start:10,end:100});
  expect(clock.setRate(rate,0)).toEqual({status:'PAUSED',time_seconds:10,rate});
  clock.play(1000);
  expect(clock.tick(3000)).toEqual({status:'PLAYING',time_seconds:10+2*rate,rate});
});

test('rate_rebases_without_jump_and_pause_settles_old_rate',()=>{
  const clock=createPlaybackClock({start:10,end:100});
  clock.play(1000);
  expect(clock.setRate(2,2500)).toEqual({status:'PLAYING',time_seconds:11.5,rate:2});
  expect(clock.tick(3000).time_seconds).toBe(12.5);
  expect(clock.pause(3500).time_seconds).toBe(13.5);
  clock.setRate(0.5,9000);
  clock.play(10000);
  expect(clock.tick(12000).time_seconds).toBe(14.5);
});

test('repeated_play_does_not_restart_or_double_count_elapsed_time',()=>{
  const clock=createPlaybackClock({start:0,end:10});
  clock.play(0);
  expect(clock.play(300).time_seconds).toBe(0.3);
  expect(clock.tick(1000).time_seconds).toBe(1);
  clock.pause(1000);clock.pause(4000);clock.play(4000);
  expect(clock.tick(5000).time_seconds).toBe(2);
});

test('seek_is_exact_and_paused_in_both_directions',()=>{
  const clock=createPlaybackClock({start:10,end:20});
  clock.play(0);
  expect(clock.seek(18,1000)).toEqual({status:'PAUSED',time_seconds:18,rate:1});
  expect(clock.tick(5000).time_seconds).toBe(18);
  expect(clock.seek(10,5000).time_seconds).toBe(10);
  clock.setRate(4,5000);clock.play(6000);
  expect(clock.tick(6250).time_seconds).toBe(11);
});

test('end_is_absorbing_until_explicit_seek_and_replay',()=>{
  const clock=createPlaybackClock({start:3,end:5});
  clock.play(10);
  expect(clock.tick(2010)).toEqual({status:'ENDED',time_seconds:5,rate:1});
  expect(clock.play(3010).status).toBe('ENDED');
  expect(clock.pause(4010).status).toBe('ENDED');
  expect(clock.setRate(4,5010)).toEqual({status:'ENDED',time_seconds:5,rate:4});
  expect(clock.tick(99999).time_seconds).toBe(5);
  expect(clock.seek(4,99999).status).toBe('PAUSED');
  clock.play(99999);
  expect(clock.tick(100999)).toEqual({status:'ENDED',time_seconds:5,rate:4});
});

test('seek_to_end_and_zero_duration_are_ended',()=>{
  const clock=createPlaybackClock({start:4,end:8});
  expect(clock.seek(8,0).status).toBe('ENDED');
  const zero=createPlaybackClock({start:4,end:4});
  expect(zero.getState()).toEqual({status:'ENDED',time_seconds:4,rate:1});
  expect(zero.play(100).status).toBe('ENDED');
  expect(zero.seek(4,100).status).toBe('ENDED');
  expect(zero.tick(200).time_seconds).toBe(4);
});

test.each([
  [NaN,10],[0,Infinity],[-Infinity,0],[0,NaN],[2,1],['0',10],[0,null],[true,2],
] as const)('rejects invalid range %s..%s',(start,end)=>{
  expect(()=>createPlaybackClock({start:start as number,end:end as number})).toThrow(RangeError);
});

test('finite_negative_origins_are_valid_and_equal_now_is_allowed',()=>{
  const clock=createPlaybackClock({start:-5,end:5});
  clock.play(-1000);
  expect(clock.tick(0).time_seconds).toBe(-4);
  expect(clock.tick(0).time_seconds).toBe(-4);
});

const badNumbers=[NaN,Infinity,-Infinity,'100',null,true,undefined] as const;
test.each(badNumbers)('rejects invalid now atomically: %s',value=>{
  for(const action of ['play','pause','tick','setRate','seek'] as const){
    const clock=createPlaybackClock({start:0,end:100});
    clock.play(0);clock.tick(100);
    const before=clock.getState();
    const run=()=>action==='setRate'?clock.setRate(2,value as number)
      :action==='seek'?clock.seek(9,value as number):clock[action](value as number);
    expect(run).toThrow(RangeError);
    expect(clock.getState()).toEqual(before);
    expect(clock.tick(200).time_seconds).toBe(0.2);
  }
});

test.each(['play','pause','tick','setRate','seek'] as const)('rejects backward now in %s',action=>{
  const clock=createPlaybackClock({start:0,end:100});
  clock.play(1000);clock.tick(2000);
  const before=clock.getState();
  const run=()=>action==='setRate'?clock.setRate(2,1999)
    :action==='seek'?clock.seek(9,1999):clock[action](1999);
  expect(run).toThrow(RangeError);
  expect(clock.getState()).toEqual(before);
  expect(clock.tick(3000).time_seconds).toBe(2);
});

test.each([0,-1,1.5,NaN,Infinity,'2',null,true] as const)('invalid rate is atomic: %s',rate=>{
  const clock=createPlaybackClock({start:0,end:100});
  clock.play(0);clock.tick(1000);
  const before=clock.getState();
  expect(()=>clock.setRate(rate as number,2000)).toThrow(RangeError);
  expect(clock.getState()).toEqual(before);
  expect(clock.tick(1500).time_seconds).toBe(1.5);
});

test.each([-1,11,NaN,Infinity,-Infinity,'2',null,true] as const)('invalid seek is atomic: %s',time=>{
  const clock=createPlaybackClock({start:0,end:10});
  clock.play(0);clock.tick(1000);
  const before=clock.getState();
  expect(()=>clock.seek(time as number,2000)).toThrow(RangeError);
  expect(clock.getState()).toEqual(before);
  expect(clock.tick(1500).time_seconds).toBe(1.5);
});

test('monotonic_validation_applies_in_paused_and_ended_states',()=>{
  for(const clock of [createPlaybackClock({start:0,end:5}),createPlaybackClock({start:5,end:5})]){
    clock.tick(100);
    expect(()=>clock.play(99)).toThrow(RangeError);
    expect(()=>clock.seek(5,99)).toThrow(RangeError);
    expect(()=>clock.setRate(2,99)).toThrow(RangeError);
  }
});

test('nonfinite_elapsed_is_rejected_without_committing_any_clock_fields',()=>{
  const clock=createPlaybackClock({start:0,end:100});
  clock.play(-Number.MAX_VALUE);
  const before=clock.getState();
  expect(()=>clock.tick(Number.MAX_VALUE)).toThrow(RangeError);
  expect(clock.getState()).toEqual(before);
  expect(clock.pause(-Number.MAX_VALUE)).toEqual({status:'PAUSED',time_seconds:0,rate:1});
});

test.each([0.5,1,2,4] as const)('long_and_short_ticks_equivalent_at_rate_%s',rate=>{
  const long=createPlaybackClock({start:0,end:10});
  const short=createPlaybackClock({start:0,end:10});
  long.setRate(rate,0);short.setRate(rate,0);long.play(0);short.play(0);
  for(let ms=100;ms<1000;ms+=100)short.tick(ms);
  expect(short.tick(1000)).toEqual(long.tick(1000));
  expect(short.getState().time_seconds).toBe(rate);
});

test('tick_partition_cannot_change_exact_end_classification',()=>{
  const clock=createPlaybackClock({start:0,end:1});
  clock.play(0);
  for(let ms=100;ms<1000;ms+=100)clock.tick(ms);
  expect(clock.tick(1000)).toEqual({status:'ENDED',time_seconds:1,rate:1});
});

test('all_returns_are_independent_frozen_snapshots',()=>{
  const clock=createPlaybackClock({start:0,end:10});
  const outputs=[clock.getState(),clock.play(0),clock.tick(500),clock.pause(500),
    clock.setRate(2,500),clock.seek(4,500),clock.getState()];
  for(const value of outputs){
    expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(value,'time_seconds',999)).toBe(false);
  }
  expect(new Set(outputs).size).toBe(outputs.length);
  expect(outputs[0]).toEqual({status:'PAUSED',time_seconds:0,rate:1});
  expect(clock.getState()).toEqual({status:'PAUSED',time_seconds:4,rate:2});
});