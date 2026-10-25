function [optpar, selected_stars, names] = read_calibration_hdf5(filename)
% Native WISC model is authoritative; MIRACLE products are approximations.
% MATLAB h5read reverses the HDF5 matrix dimensions; transpose to star rows.
if nargin < 1, filename = 'calibration.h5'; end
optpar = h5read(filename, '/best_fit_wisc_optpar_with_optmod');
selected_stars = h5read(filename, '/selected_stars').';
names = jsondecode(h5readatt(filename, '/', 'selected_star_names'));
disp('optpar includes optmod as its first element:'); disp(optpar(:).');
disp('HDF5 selected-star row/column values are one-based.');
end
